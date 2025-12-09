package main

import (
	"context"
	"crypto/hmac"
	"encoding/base64"
	"html/template"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"cloud.google.com/go/datastore"
	"google.golang.org/api/iterator"
)

// PlayerLocation represents the data we store for each player.
type PlayerLocation struct {
	Lat             float64   `json:"lat,omitempty"`
	Lng             float64   `json:"lng,omitempty"`
	Timestamp       time.Time `json:"timestamp"`       // Server-side timestamp of the update
	ClientTimestamp time.Time `json:"clientTimestamp"` // Client-side timestamp of the location fix or status change
	Status          string    `json:"status"`          // e.g., "OK", "UNAVAILABLE", "DENIED"
}

// PlayerMessage represents a message sent from a player to the game leads.
type PlayerMessage struct {
	ID        int64     `json:"id" datastore:"-"` // The datastore key ID
	PlayerID  string    `json:"playerID"`
	Content   string    `json:"content" datastore:",noindex"`
	Timestamp time.Time `json:"timestamp"`
	IsRead    bool      `json:"isRead"`
}

// DirectMessage represents a message sent from a game lead to a player.
type DirectMessage struct {
	ID        int64     `json:"id" datastore:"-"`
	PlayerID  string    `json:"playerID"`
	Content   string    `json:"content" datastore:",noindex"`
	Timestamp time.Time `json:"timestamp"`
}

// TestResult stores the outcome of a player's pre-game test.
type TestResult struct {
	PlayerName         string    `json:"playerName"`
	LocationStatus     string    `json:"locationStatus" datastore:",noindex"`
	NotificationStatus string    `json:"notificationStatus" datastore:",noindex"`
	ServerStatus       string    `json:"serverStatus" datastore:",noindex"`
	Timestamp          time.Time `json:"timestamp"`
}

// TargetLocation represents a target location sent from a game lead to a player.
type TargetLocation struct {
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Timestamp time.Time `json:"timestamp"`
	FakeHash  string    `json:"fakeHash"`
	IsReleased bool      `json:"isReleased"`
}

// ChatMessage is a generic struct for sending combined chat history to the frontend.
type ChatMessage struct {
	From      string    `json:"from"` // "player" or "lead"
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp"`
	IsRead    bool      `json:"isRead,omitempty"`
}

// A secret key for hashing. In a real production app, this should be loaded securely.
const hmacSecret = "a-very-secret-key-for-the-game"

// --- Player ID Obfuscation ---
const idKey = "THIS_IS_A_STATIC_32_BYTE_SECRET_KEY" // 32 bytes for AES-256

// obfuscatePlayerID takes a real player ID and returns a URL-safe obfuscated string.
func obfuscatePlayerID(playerID string) string {
	idBytes := []byte(playerID)
	keyBytes := []byte(idKey)
	obfuscated := make([]byte, len(idBytes))
	for i := 0; i < len(idBytes); i++ {
		// XOR the player ID byte with a byte from the key, repeating the key if necessary.
		obfuscated[i] = idBytes[i] ^ keyBytes[i%len(keyBytes)]
	}

	return base64.URLEncoding.EncodeToString(obfuscated)
}

// deobfuscatePlayerID takes an obfuscated string and returns the real player ID.
func deobfuscatePlayerID(obfuscatedID string) (string, error) {
	decoded, err := base64.URLEncoding.DecodeString(obfuscatedID)
	if err != nil {
		return "", fmt.Errorf("invalid obfuscated id format")
	}

	keyBytes := []byte(idKey)
	deobfuscated := make([]byte, len(decoded))
	for i := 0; i < len(decoded); i++ {
		deobfuscated[i] = decoded[i] ^ keyBytes[i%len(keyBytes)]
	}

	return string(deobfuscated), nil
}

type ObfuscatedURLResponse struct {
	PlayerID      string `json:"playerID"`
	ObfuscatedID  string `json:"obfuscatedID"`
	ObfuscatedURL string `json:"obfuscatedURL"`
}

// Global datastore client.
var dsClient *datastore.Client

func main() {
	ctx := context.Background()
	projectID := os.Getenv("GOOGLE_CLOUD_PROJECT")
	// For local development, GOOGLE_CLOUD_PROJECT might not be set.
	// If the datastore emulator is being used, we can use a default project ID.
	if projectID == "" && os.Getenv("DATASTORE_EMULATOR_HOST") != "" {
		projectID = "droppydrop" // Use the default project ID from launch.json
		log.Printf("GOOGLE_CLOUD_PROJECT not set. Using default '%s' for local development.", projectID)
	} else if projectID == "" {
		log.Fatal("GOOGLE_CLOUD_PROJECT environment variable must be set when not using the datastore emulator.")
	}

	var err error
	dsClient, err = datastore.NewClient(ctx, projectID)
	if err != nil {
		log.Fatalf("Failed to create datastore client: %v", err)
	}

	// App Engine automatically sets the PORT env variable.
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
		log.Printf("Defaulting to port %s", port)
	}

	// API handlers
	http.HandleFunc("/gamelead", serveTemplate("static/gamelead.html"))
	http.HandleFunc("/player/", serveTemplate("static/player.html"))
	http.HandleFunc("/test", serveTemplate("static/test.html"))
	http.HandleFunc("/generator", serveTemplate("static/generator.html"))
	http.HandleFunc("/testresults", serveTemplate("static/testresults.html"))

	http.HandleFunc("/api/locations/", handleUpdateLocation) // POST /api/locations/{playerID}
	http.HandleFunc("/api/locations", handleGetLocations)   // GET /api/locations

	// Message API handlers
	http.HandleFunc("/api/messages/read/", handleMarkMessageRead) // POST for leads
	http.HandleFunc("/api/messages/", handlePlayerMessages)       // POST and GET for players
	http.HandleFunc("/api/messages", handleMessages)              // GET for leads
	http.HandleFunc("/api/dm/", handleSendDirectMessage)          // POST for leads to send DM
	http.HandleFunc("/api/chat/", handleChatHistory)              // GET for chat history
	http.HandleFunc("/api/target/", handleSetTargetLocation)      // POST for leads to set a target
	http.HandleFunc("/api/targets", handleGetTargets)             // GET for all targets
	http.HandleFunc("/api/obfuscate-url", handleObfuscateURL)     // POST to get an obfuscated URL
	http.HandleFunc("/api/test-result", handleTestResult)         // POST for test page results
	http.HandleFunc("/api/test-results", handleGetTestResults)    // GET for all test results
	http.HandleFunc("/api/admin/load-initial-targets", handleLoadInitialTargets) // POST to load targets from file
	http.HandleFunc("/api/admin/clear-datastore", handleClearDatastore) // Temporary admin endpoint

	// Start the server
	log.Printf("Listening on http://localhost:%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}

// serveTemplate is a helper function that creates an HTTP handler for serving
// a given HTML file as a template, injecting a cache-busting version string.
func serveTemplate(filename string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// GAE_VERSION is a unique identifier for each deployed version.
		appVersion := os.Getenv("GAE_VERSION")
		if appVersion == "" {
			// Fallback for local development: use current timestamp as version.
			appVersion = fmt.Sprintf("local-%d", time.Now().Unix())
		}

		// Parse the HTML file as a template.
		tmpl, err := template.ParseFiles(filename)
		if err != nil {
			log.Printf("ERROR: could not parse template %s: %v", filename, err)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}

		// Execute the template, passing in the version data.
		if err := tmpl.Execute(w, map[string]string{"AppVersion": appVersion}); err != nil {
			log.Printf("ERROR: could not execute template %s: %v", filename, err)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		}
	}
}

// handleUpdateLocation handles players posting their location.
// It expects a POST request to /api/locations/{playerID}
func handleUpdateLocation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract obfuscatedID from URL path: /api/locations/{obfuscatedID}
	obfuscatedID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/locations/"), "/")
	playerID, err := deobfuscatePlayerID(obfuscatedID)
	if err != nil {
		http.Error(w, "Player ID is missing in the URL", http.StatusBadRequest)
		return
	}

	var reqBody struct {
		Lat             *float64  `json:"lat,omitempty"`
		Lng             *float64  `json:"lng,omitempty"`
		ClientTimestamp time.Time `json:"clientTimestamp"`
		Status          string    `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	// Use the global client.
	ctx := context.Background()

	// The key is the player's unique ID. This acts as an "upsert".
	key := datastore.NameKey("PlayerLocation", playerID, nil)

	// Start with the new information.
	loc := PlayerLocation{
		Timestamp:       time.Now(), // Server receives it now
		ClientTimestamp: reqBody.ClientTimestamp,
		Status:          reqBody.Status,
	}

	if reqBody.Status == "OK" && reqBody.Lat != nil && reqBody.Lng != nil { // A good update with coordinates
		loc.Lat = *reqBody.Lat
		loc.Lng = *reqBody.Lng
	} else if reqBody.Status != "OK" { // A status-only update (e.g., "DENIED")
		// Preserve the last known coordinates by fetching the existing entity.
		var existingLoc PlayerLocation
		if err := dsClient.Get(ctx, key, &existingLoc); err == nil && existingLoc.Lat != 0 {
			// If we have a last known location, use it.
			loc.Lat = existingLoc.Lat
			loc.Lng = existingLoc.Lng
		} else {
			// Otherwise, this is a new player with no location. Place them at the default location.
			loc.Lat = 51.03528074190589
			loc.Lng = 3.9737665526527852
		}
	}

	if _, err := dsClient.Put(ctx, key, &loc); err != nil { // Save the new struct
		log.Printf("ERROR: Failed to save location for player %s: %v", playerID, err)
		http.Error(w, "Internal server error when saving location.", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// handleGetLocations handles requests from the game lead to get all locations.
// It expects a GET request to /api/locations
func handleGetLocations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Only GET method is allowed", http.StatusMethodNotAllowed)
		return
	}

	// Use the global client.
	ctx := context.Background()

	query := datastore.NewQuery("PlayerLocation")
	locations := make(map[string]PlayerLocation)
	it := dsClient.Run(ctx, query)
	for {
		var loc PlayerLocation
		key, err := it.Next(&loc)
		if err == iterator.Done {
			break
		}
		if err != nil {
			log.Printf("ERROR: Failed to iterate over locations: %v", err)
			http.Error(w, "Internal server error when fetching locations.", http.StatusInternalServerError)
			return
		}
		locations[key.Name] = loc
	}

	w.Header().Set("Content-Type", "application/json")
	// It's safe to encode the error here as it's from the JSON marshaller.
	if err := json.NewEncoder(w).Encode(locations); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handlePlayerMessages handles players sending messages (POST) and checking their last message status (GET).
func handlePlayerMessages(w http.ResponseWriter, r *http.Request) {
	obfuscatedID := strings.TrimPrefix(r.URL.Path, "/api/messages/")
	playerID, err := deobfuscatePlayerID(obfuscatedID)
	if err != nil {
		http.Error(w, "Player ID is missing", http.StatusBadRequest)
		return
	}

	ctx := context.Background()

	switch r.Method {
	case http.MethodPost:
		// Player sends a new message
		var reqBody struct {
			Message string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}

		msg := &PlayerMessage{
			PlayerID:  playerID,
			Content:   reqBody.Message,
			Timestamp: time.Now(),
			IsRead:    false,
		}

		key := datastore.IncompleteKey("PlayerMessage", nil)
		newKey, err := dsClient.Put(ctx, key, msg)
		if err != nil {
			log.Printf("ERROR: Failed to save message for player %s: %v", playerID, err)
			http.Error(w, "Internal server error when saving message.", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "id": newKey.ID})

	case http.MethodGet:
		// Player checks the status of their last message
		query := datastore.NewQuery("PlayerMessage").
			FilterField("PlayerID", "=", playerID).
			Order("-Timestamp").
			Limit(1)

		var messages []PlayerMessage
		keys, err := dsClient.GetAll(ctx, query, &messages)
		if err != nil {
			log.Printf("ERROR: Failed to get last message for player %s: %v", playerID, err)
			http.Error(w, "Internal server error retrieving message status.", http.StatusInternalServerError)
			return
		}

		// Also get the latest DM for this player
		dmQuery := datastore.NewQuery("DirectMessage").
			FilterField("PlayerID", "=", playerID).
			Order("-Timestamp").
			Limit(1)

		var dms []DirectMessage
		_, err = dsClient.GetAll(ctx, dmQuery, &dms)
		if err != nil {
			log.Printf("ERROR: Failed to get last DM for player %s: %v", playerID, err)
			http.Error(w, "Internal server error retrieving direct message.", http.StatusInternalServerError)
			return
		}

		// Also get the target location for this player
		var targetLoc TargetLocation
		targetKey := datastore.NameKey("TargetLocation", playerID, nil)
		err = dsClient.Get(ctx, targetKey, &targetLoc)
		// It's okay if it's not found, so we only handle other errors.
		hasTarget := (err == nil)
		if err != nil && err != datastore.ErrNoSuchEntity { // Don't log "not found" as an error
			log.Printf("Failed to get target location for player %s: %v", playerID, err)
			// Don't fail the whole request, just log the error.
		}

		// We don't handle the 404 case here, if there are no messages, the slices will be empty.
		// The frontend will handle this.

		w.Header().Set("Content-Type", "application/json")
		response := make(map[string]interface{})
		if len(messages) > 0 {
			messages[0].ID = keys[0].ID // Add the ID to the struct
			response["playerMessage"] = messages[0]
		}
		if len(dms) > 0 {
			response["dm"] = dms[0]
		}
		if hasTarget {
			response["target"] = targetLoc
		}
		json.NewEncoder(w).Encode(response)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleMessages handles game leads fetching all messages.
func handleMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Only GET method is allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx := context.Background()
	query := datastore.NewQuery("PlayerMessage").Order("-Timestamp")

	var messages []PlayerMessage
	keys, err := dsClient.GetAll(ctx, query, &messages)
	if err != nil {
		log.Printf("ERROR: Error fetching all messages: %v", err)
		http.Error(w, "Internal server error when fetching messages.", http.StatusInternalServerError)
		return
	}

	// Populate the ID field for each message from its key
	for i := 0; i < len(messages); i++ {
		messages[i].ID = keys[i].ID
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(messages); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleMarkMessageRead handles game leads marking a message as read.
func handleMarkMessageRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx := context.Background()

	// Extract messageID from URL path: /api/messages/read/{messageID}
	idStr := strings.TrimPrefix(r.URL.Path, "/api/messages/read/")
	var messageID int64
	if _, err := fmt.Sscan(idStr, &messageID); err != nil {
		http.Error(w, "Invalid message ID", http.StatusBadRequest)
		return
	}

	key := datastore.IDKey("PlayerMessage", messageID, nil)
	var msg PlayerMessage
	if err := dsClient.Get(ctx, key, &msg); err != nil {
		// This could be a client error (bad ID) or a server error.
		log.Printf("ERROR: Failed to get message %d to mark as read: %v", messageID, err)
		http.Error(w, "Message not found", http.StatusNotFound)
		return
	}

	msg.IsRead = true
	if _, err := dsClient.Put(ctx, key, &msg); err != nil {
		http.Error(w, "Internal server error when updating message.", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// handleSendDirectMessage handles a game lead sending a message to a player.
func handleSendDirectMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	obfuscatedID := strings.TrimPrefix(r.URL.Path, "/api/dm/")
	playerID, err := deobfuscatePlayerID(obfuscatedID)
	if err != nil {
		http.Error(w, "Player ID is missing", http.StatusBadRequest)
		return
	}

	var reqBody struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	dm := &DirectMessage{
		PlayerID:  playerID,
		Content:   reqBody.Message,
		Timestamp: time.Now(),
	}

	ctx := context.Background()
	key := datastore.IncompleteKey("DirectMessage", nil)
	if _, err := dsClient.Put(ctx, key, dm); err != nil {
		log.Printf("ERROR: Failed to save DM for player %s: %v", playerID, err)
		http.Error(w, "Internal server error when saving direct message.", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

// handleGetTargets handles requests from the game lead to get all target locations.
func handleGetTargets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Only GET method is allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := context.Background()

	query := datastore.NewQuery("TargetLocation")
	targets := make(map[string]TargetLocation)
	it := dsClient.Run(ctx, query)
	for {
		var loc TargetLocation
		key, err := it.Next(&loc)
		if err == iterator.Done {
			break
		}
		if err != nil {
			log.Printf("ERROR: Failed to iterate over targets: %v", err)
			http.Error(w, "Internal server error when fetching targets.", http.StatusInternalServerError)
			return
		}
		targets[key.Name] = loc
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(targets); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleChatHistory serves the full conversation history for a given player.
func handleChatHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Only GET method is allowed", http.StatusMethodNotAllowed)
		return
	}

	obfuscatedID := strings.TrimPrefix(r.URL.Path, "/api/chat/")
	playerID, err := deobfuscatePlayerID(obfuscatedID)
	if err != nil {
		http.Error(w, "Player ID is missing", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	// Initialize as an empty slice to ensure we return [] instead of null in JSON.
	allMessages := make([]ChatMessage, 0)

	// Get messages from the player
	playerQuery := datastore.NewQuery("PlayerMessage").FilterField("PlayerID", "=", playerID)
	var playerMessages []PlayerMessage
	if _, err := dsClient.GetAll(ctx, playerQuery, &playerMessages); err != nil {
		log.Printf("ERROR: Failed to retrieve player messages for chat history (%s): %v", playerID, err)
		http.Error(w, "Internal server error retrieving player messages.", http.StatusInternalServerError)
		return
	}
	for _, msg := range playerMessages {
		allMessages = append(allMessages, ChatMessage{
			From:      "player",
			Content:   msg.Content,
			Timestamp: msg.Timestamp,
			IsRead:    msg.IsRead,
		})
	}

	// Get messages from the game leads (DMs)
	dmQuery := datastore.NewQuery("DirectMessage").FilterField("PlayerID", "=", playerID)
	var dms []DirectMessage
	if _, err := dsClient.GetAll(ctx, dmQuery, &dms); err != nil {
		log.Printf("ERROR: Failed to retrieve direct messages for chat history (%s): %v", playerID, err)
		http.Error(w, "Internal server error retrieving direct messages.", http.StatusInternalServerError)
		return
	}
	for _, msg := range dms {
		allMessages = append(allMessages, ChatMessage{
			From:      "lead",
			Content:   msg.Content,
			Timestamp: msg.Timestamp,
		})
	}

	// Sort all messages by timestamp ascending
	sort.Slice(allMessages, func(i, j int) bool {
		return allMessages[i].Timestamp.Before(allMessages[j].Timestamp)
	})

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(allMessages); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleSetTargetLocation handles a game lead setting a target location for a player.
func handleSetTargetLocation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	obfuscatedID := strings.TrimPrefix(r.URL.Path, "/api/target/")
	playerID, err := deobfuscatePlayerID(obfuscatedID)
	if err != nil {
		http.Error(w, "Player ID is missing", http.StatusBadRequest)
		return
	}

	var reqBody struct {
		Lat float64 `json:"lat"`
		Lng float64 `json:"lng"`
	}
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	now := time.Now()
	// Generate a non-reversible hash from the coordinates and timestamp.
	mac := hmac.New(sha256.New, []byte(hmacSecret))
	data := fmt.Sprintf("%.6f,%.6f,%d", reqBody.Lat, reqBody.Lng, now.UnixNano())
	mac.Write([]byte(data))
	fakeHash := strings.ToUpper(hex.EncodeToString(mac.Sum(nil))[:8])

	target := &TargetLocation{
		Lat:       reqBody.Lat,
		Lng:       reqBody.Lng,
		Timestamp: now,
		FakeHash:  fakeHash,
		IsReleased: true, // Targets set during the game are always released immediately.
	}

	ctx := context.Background()
	key := datastore.NameKey("TargetLocation", playerID, nil)
	if _, err := dsClient.Put(ctx, key, target); err != nil {
		log.Printf("ERROR: Failed to save target for player %s: %v", playerID, err)
		http.Error(w, "Internal server error when saving target location.", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

// handleObfuscateURL creates a new obfuscated URL for a given player name.
func handleObfuscateURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	var reqBody struct {
		PlayerID   string   `json:"playerID"`
		Target     *struct { // Make target optional
			Lat float64 `json:"lat"`
			Lng float64 `json:"lng"`
		} `json:"target"`
	}
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	obfuscatedID := obfuscatePlayerID(reqBody.PlayerID)

	baseURL := "https://" + r.Host // In production, this will be your appspot domain.
	if r.Host == "" || strings.HasPrefix(r.Host, "localhost") {
		baseURL = "http://" + r.Host
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ObfuscatedURLResponse{PlayerID: reqBody.PlayerID, ObfuscatedID: obfuscatedID, ObfuscatedURL: fmt.Sprintf("%s/player/%s", baseURL, obfuscatedID)})
}

// handleTestResult handles submissions of pre-game test results.
func handleTestResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	var reqBody struct {
		PlayerName         string `json:"playerName"`
		LocationStatus     string `json:"locationStatus"`
		NotificationStatus string `json:"notificationStatus"`
		ServerStatus       string `json:"serverStatus"`
	}
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	if reqBody.PlayerName == "" {
		http.Error(w, "PlayerName is required", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	// Use the player's name as the key to "upsert" their latest test result.
	key := datastore.NameKey("TestResult", reqBody.PlayerName, nil)

	result := &TestResult{
		PlayerName:         reqBody.PlayerName,
		LocationStatus:     reqBody.LocationStatus,
		NotificationStatus: reqBody.NotificationStatus,
		ServerStatus:       reqBody.ServerStatus,
		Timestamp:          time.Now(),
	}

	if _, err := dsClient.Put(ctx, key, result); err != nil {
		log.Printf("ERROR: Failed to save test result for player %s: %v", reqBody.PlayerName, err)
		http.Error(w, "Internal server error when saving test result.", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// handleGetTestResults serves all stored pre-game test results.
func handleGetTestResults(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Only GET method is allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := context.Background()
	// Query for all test results, ordered by the most recent timestamp first.
	query := datastore.NewQuery("TestResult").Order("-Timestamp")

	var results []TestResult
	// Using GetAll is fine for a moderate number of players.
	// For a very large number, we would implement pagination.
	if _, err := dsClient.GetAll(ctx, query, &results); err != nil {
		log.Printf("ERROR: Failed to fetch test results: %v", err)
		http.Error(w, "Internal server error when fetching test results.", http.StatusInternalServerError)
		return
	}

	// If no results are found, return an empty array instead of null.
	if results == nil {
		results = make([]TestResult, 0)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(results); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleLoadInitialTargets reads a static JSON file and creates released targets for all players listed.
func handleLoadInitialTargets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
		return
	}

	// Read the static JSON file
	jsonFile, err := os.Open("static/initial_targets.json")
	if err != nil {
		log.Printf("ERROR: Failed to open initial_targets.json: %v", err)
		http.Error(w, "Could not find initial_targets.json on the server.", http.StatusInternalServerError)
		return
	}
	defer jsonFile.Close()

	var initialTargets []struct {
		PlayerName string `json:"playerName"`
		Target     struct {
			Lat float64 `json:"lat"`
			Lng float64 `json:"lng"`
		} `json:"target"`
	}

	if err := json.NewDecoder(jsonFile).Decode(&initialTargets); err != nil {
		log.Printf("ERROR: Failed to parse initial_targets.json: %v", err)
		http.Error(w, "Failed to parse initial_targets.json.", http.StatusInternalServerError)
		return
	}

	ctx := context.Background()
	var keys []*datastore.Key
	var targets []*TargetLocation

	for _, it := range initialTargets {
		now := time.Now()
		mac := hmac.New(sha256.New, []byte(hmacSecret))
		data := fmt.Sprintf("%.6f,%.6f,%d", it.Target.Lat, it.Target.Lng, now.UnixNano())
		mac.Write([]byte(data))
		fakeHash := strings.ToUpper(hex.EncodeToString(mac.Sum(nil))[:8])

		keys = append(keys, datastore.NameKey("TargetLocation", it.PlayerName, nil))
		targets = append(targets, &TargetLocation{
			Lat:        it.Target.Lat,
			Lng:        it.Target.Lng,
			Timestamp:  now,
			FakeHash:   fakeHash,
			IsReleased: true, // These targets are immediately released.
		})
	}

	if _, err := dsClient.PutMulti(ctx, keys, targets); err != nil {
		log.Printf("ERROR: Failed to save initial targets: %v", err)
		http.Error(w, "Internal server error when saving initial targets.", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{"message": fmt.Sprintf("Successfully loaded and set %d initial targets.", len(targets))})
}

// handleClearDatastore is a temporary admin function to wipe all known kinds from the datastore.
// WARNING: This deletes all data. Use with caution.
func handleClearDatastore(w http.ResponseWriter, r *http.Request) {
	// Simple protection to prevent accidental calls.
	// In a real app, this should be behind proper admin authentication.
	if r.URL.Query().Get("confirm") != "true" {
		http.Error(w, "This is a destructive operation. Add `?confirm=true` to the URL to proceed.", http.StatusForbidden)
		return
	}

	ctx := context.Background()
	kinds := []string{"PlayerLocation", "PlayerMessage", "DirectMessage", "TargetLocation", "TestResult"}
	totalDeleted := 0

	for _, kind := range kinds {
		q := datastore.NewQuery(kind).KeysOnly()
		keys, err := dsClient.GetAll(ctx, q, nil)
		if err != nil {
			log.Printf("Failed to get keys for kind %s: %v", kind, err)
			http.Error(w, fmt.Sprintf("Failed to get keys for kind %s", kind), http.StatusInternalServerError)
			return
		}

		if len(keys) == 0 {
			continue
		}

		// Datastore allows deleting up to 500 keys at a time. Batch the deletes.
		for i := 0; i < len(keys); i += 500 {
			end := i + 500
			if end > len(keys) {
				end = len(keys)
			}
			batch := keys[i:end]
			if err := dsClient.DeleteMulti(ctx, batch); err != nil {
				log.Printf("Failed to delete batch of keys for kind %s: %v", kind, err)
				http.Error(w, fmt.Sprintf("Failed to delete keys for kind %s", kind), http.StatusInternalServerError)
				return
			}
		}
		log.Printf("Deleted %d entities of kind %s", len(keys), kind)
		totalDeleted += len(keys)
	}

	fmt.Fprintf(w, "Successfully deleted %d entities across %d kinds.", totalDeleted, len(kinds))
}
