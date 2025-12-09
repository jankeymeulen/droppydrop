document.addEventListener("DOMContentLoaded", () => {
  // Initialize the map and set its view to a default location
  const map = L.map('map').setView([50.8503, 4.3517], 9); // Centered on Brussels

  // Add an OpenStreetMap tile layer
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  // A single marker cluster group for all markers (players and targets)
  const mainMarkerGroup = L.markerClusterGroup({
    iconCreateFunction: function(cluster) {
      const childCount = cluster.getChildCount();
      const markers = cluster.getAllChildMarkers();

      let hasPlayer = false;
      let hasTarget = false;
      for (const marker of markers) {
        if (marker.options.type === 'player') hasPlayer = true;
        if (marker.options.type === 'target') hasTarget = true;
        if (hasPlayer && hasTarget) break; // Optimization
      }

      let clusterTypeClass = '';
      if (hasPlayer && hasTarget) {
        clusterTypeClass = 'mixed-cluster';
      } else if (hasPlayer) {
        clusterTypeClass = 'player-cluster';
      } else {
        clusterTypeClass = 'target-cluster';
      }

      // Use the default size classes from Leaflet.markercluster
      let sizeClass = ' marker-cluster-';
      if (childCount < 10) sizeClass += 'small';
      else if (childCount < 100) sizeClass += 'medium';
      else sizeClass += 'large';

      return new L.DivIcon({
        html: '<div><span>' + childCount + '</span></div>',
        className: 'marker-cluster ' + clusterTypeClass + sizeClass,
        iconSize: new L.Point(40, 40)
      });
    }
  });
  map.addLayer(mainMarkerGroup);

  // This object will store player markers, with playerID as the key
  const playerMarkers = {};
  const targetMarkers = {};
  const playerTargetLines = {};
  const legendItemsEl = document.getElementById('legend-items');
  const messageFeedEl = document.getElementById('message-feed');
  const playerActionsEl = document.getElementById('player-actions');

  // State for location selection mode
  let isLocationSelectMode = false;

  let selectedPlayerIDs = new Set();
  // Keep track of the last clicked player for shift-selection
  let lastClickedPlayerID = null;

  // --- Helper Functions for Colors and Markers ---

  // We use a counter and the golden ratio to generate well-distributed, visually distinct colors.
  // This avoids the clustering issues of a simple hash.
  const playerColorMap = new Map();
  let colorCounter = 0;
  const goldenRatioConjugate = 0.618033988749895;

  // Generate a consistent color from a player ID
  function getColorForPlayer(playerID) {
    if (!playerColorMap.has(playerID)) {
      // Generate a new hue using the golden ratio for good distribution
      const hue = (colorCounter * goldenRatioConjugate * 360) % 360;
      colorCounter++;
      const color = `hsl(${hue}, 90%, 45%)`;
      playerColorMap.set(playerID, color);
    }
    return playerColorMap.get(playerID);
  }

  // Create a custom SVG marker icon with a specific color
  function createColoredIcon(color, extraClassName = '') {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" class="leaflet-marker-icon player-marker-svg">
        <path fill-opacity="0.9" fill="${color}" stroke="black" stroke-width="1.5" d="M16 0 C7.16 0 0 7.16 0 16 s16 16 16 16 16-7.16 16-16 S24.84 0 16 0 Z"></path>
        <circle cx="16" cy="16" r="6" fill="white"/>
      </svg>`;
    
    return L.divIcon({
      html: svg,
      className: extraClassName, // Pass in extra classes like 'stale-location'
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  // Create a custom SVG marker icon for targets
  function createTargetIcon(color) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="leaflet-marker-icon">
        <path fill="${color}" stroke="black" stroke-width="1" 
        d="M12 .5l3.09 6.26L22 7.77l-5 4.87 1.18 6.88L12 16.31l-6.18 3.22L7 12.64l-5-4.87 6.91-1.01L12 .5z"/>
      </svg>`;
    
    return L.divIcon({
      html: svg,
      className: '',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  // Find the center map button and add a click listener
  const centerMapButton = document.getElementById('center-map-button');
  centerMapButton.addEventListener('click', () => {
    const playerLocations = Object.values(playerMarkers).map(marker => marker.getLatLng());
    const targetLocations = Object.values(targetMarkers).map(marker => marker.getLatLng());
    const allLocations = playerLocations.concat(targetLocations);

    if (allLocations.length > 0) {
      // Create a LatLngBounds object from all marker locations
      const bounds = L.latLngBounds(allLocations);
      // Tell the map to fit itself to those bounds, with some padding
      map.fitBounds(bounds, { padding: [50, 50] });
    } else {
      alert("No players are on the map yet!");
    }
  });

  // --- Load Initial Targets Button ---
  const loadTargetsBtn = document.getElementById('load-targets-btn');
  loadTargetsBtn.addEventListener('click', async () => {
    if (!confirm("Are you sure you want to load and set all initial targets from initial_targets.json? This will overwrite any existing targets for those players.")) {
      return;
    }

    loadTargetsBtn.disabled = true;
    loadTargetsBtn.textContent = 'Loading...';

    try {
      const response = await fetch('/api/admin/load-initial-targets', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'An unknown error occurred.');
      alert(`Success: ${result.message}`);
    } catch (error) {
      console.error('Failed to load initial targets:', error);
      alert(`Error: ${error.message}`);
    } finally {
      loadTargetsBtn.disabled = false;
      loadTargetsBtn.textContent = 'Load Initial Targets from File';
    }
  });

  // --- Player Selection and Actions ---

  function handlePlayerSelection(clickedPlayerID, event) {
    const isCtrlOrMeta = event.ctrlKey || event.metaKey; // metaKey for Mac
    const isShift = event.shiftKey;

    if (isShift && lastClickedPlayerID) {
      // Shift-click for range selection
      const legendItems = Array.from(document.querySelectorAll('.legend-item'));
      const playerIDsInOrder = legendItems.map(item => item.dataset.playerId);
      const start = playerIDsInOrder.indexOf(lastClickedPlayerID);
      const end = playerIDsInOrder.indexOf(clickedPlayerID);

      if (start !== -1 && end !== -1) {
        const range = playerIDsInOrder.slice(Math.min(start, end), Math.max(start, end) + 1);
        if (!isCtrlOrMeta) {
          selectedPlayerIDs.clear();
        }
        range.forEach(id => selectedPlayerIDs.add(id));
      }
    } else if (isCtrlOrMeta) {
      // Ctrl/Cmd-click to toggle selection
      if (selectedPlayerIDs.has(clickedPlayerID)) {
        selectedPlayerIDs.delete(clickedPlayerID);
      } else {
        selectedPlayerIDs.add(clickedPlayerID);
      }
    } else {
      // Regular click
      if (selectedPlayerIDs.has(clickedPlayerID) && selectedPlayerIDs.size === 1) {
        // If it's the only one selected, deselect it
        selectedPlayerIDs.clear();
      } else {
        // Otherwise, select only this one
        selectedPlayerIDs.clear();
        selectedPlayerIDs.add(clickedPlayerID);
      }
    }

    lastClickedPlayerID = clickedPlayerID; // Update last clicked for shift-select
    renderPlayerActions();

    // Highlight in legend
    document.querySelectorAll('.legend-item').forEach(item => {
      item.classList.toggle('selected', selectedPlayerIDs.has(item.dataset.playerId));
    });
  }

  // Helper function to format time difference
  function formatTimeAgo(timestamp) {
    const now = new Date();
    const then = new Date(timestamp);
    const seconds = Math.floor((now - then) / 1000);

    if (seconds < 60) {
      return "just now";
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    } else if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    } else {
      const days = Math.floor(seconds / 86400);
      return `${days} day${days === 1 ? '' : 's'} ago`;
    }
  }

  // --- Player Selection and Actions ---

  // ... (rest of the handlePlayerSelection function remains the same)

  async function renderPlayerActions() {
    if (selectedPlayerIDs.size === 0) {
      playerActionsEl.innerHTML = '<p>Click a player on the map or in the legend to see actions.</p>';
      return;
    }

    if (selectedPlayerIDs.size === 1) {
      // --- SINGLE PLAYER SELECTED ---
      const [selectedPlayerID] = selectedPlayerIDs;
      const playerColor = getColorForPlayer(selectedPlayerID);
      playerActionsEl.innerHTML = `
        <h3>Actions for <span style="color: ${playerColor};">${selectedPlayerID}</span></h3>
        <button id="send-location-btn">Send Location</button>
        <hr>
        <div id="chat-history">Loading chat...</div>
        <div id="dm-form">
          <textarea id="dm-input" rows="2" placeholder="Type a message..."></textarea>
          <button id="send-dm-button">Send Message</button>
          <div id="dm-send-status"></div>
        </div>
      `;

      // Fetch and render chat history
      try {
        // First, we need to get the obfuscated ID for the selected player to make the correct API call.
        const obfusResponse = await fetch('/api/obfuscate-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerID: selectedPlayerID }),
        });
        if (!obfusResponse.ok) throw new Error('Could not obfuscate player ID.');
        const obfusData = await obfusResponse.json();

        const response = await fetch(`/api/chat/${obfusData.obfuscatedID}`);
        if (!response.ok) throw new Error('Failed to load chat history.');
        const chatMessages = await response.json();
        const chatHistoryEl = document.getElementById('chat-history');
        
        if (!chatMessages || chatMessages.length === 0) {
          chatHistoryEl.innerHTML = '<p style="text-align: center; color: #888;">No messages yet.</p>';
        } else {
          chatHistoryEl.innerHTML = ''; // Clear "Loading..."
          chatMessages.forEach(msg => {
            const msgEl = document.createElement('div');
            msgEl.className = 'chat-message';
            const timestamp = new Date(msg.timestamp).toLocaleTimeString([], { hour12: false });
            const from = msg.from === 'player' ? selectedPlayerID : 'Game Lead';
            const fromColor = msg.from === 'player' ? playerColor : 'black';

            msgEl.innerHTML = `
              <div class="chat-header">From: <strong style="color: ${fromColor};">${from}</strong> at ${timestamp}</div>
              <div class="message-content">${msg.content}</div>
            `;
            chatHistoryEl.appendChild(msgEl);
          });
          // Scroll to the bottom
          chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        }
      } catch (error) {
        document.getElementById('chat-history').innerHTML = `<p style="color: red;">${error.message}</p>`;
      }

      // Wire up the send location button
      document.getElementById('send-location-btn').addEventListener('click', enterLocationSelectMode);
    } else {
      // --- MULTIPLE PLAYERS SELECTED ---
      const selectedPlayersHtml = Array.from(selectedPlayerIDs).map(id => 
        `<span style="color: ${getColorForPlayer(id)}; font-weight: bold;">${id}</span>`
      ).join(', ');

      playerActionsEl.innerHTML = `
        <h3>Group Message (${selectedPlayerIDs.size} players)</h3>
        <button id="send-location-btn">Send Location to All</button>
        <hr>
        <p>Sending to: ${selectedPlayersHtml}</p>
        <div id="dm-form">
          <textarea id="dm-input" rows="4" placeholder="Type a message to send to all selected players..."></textarea>
          <button id="send-dm-button">Send to All</button>
          <div id="dm-send-status"></div>
        </div>
      `;

      // Wire up the send location button
      document.getElementById('send-location-btn').addEventListener('click', enterLocationSelectMode);
    }

    // Wire up the send button
    document.getElementById('send-dm-button').addEventListener('click', async () => {
      const input = document.getElementById('dm-input');
      const statusEl = document.getElementById('dm-send-status');
      const message = input.value.trim();

      if (!message) return;

      const button = document.getElementById('send-dm-button');
      button.disabled = true;
      button.textContent = 'Sending...';
      statusEl.textContent = '';

      try {
        // We need to get obfuscated IDs for all selected players.
        const obfusPromises = Array.from(selectedPlayerIDs).map(playerID =>
          fetch('/api/obfuscate-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerID: playerID }),
          }).then(res => res.json())
        );
        const obfusDataArray = await Promise.all(obfusPromises);

        const sendPromises = obfusDataArray.map(obfusData =>
          fetch(`/api/dm/${obfusData.obfuscatedID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
          }).then(res => { if (!res.ok) throw new Error(`Failed for ${playerID}`) })
        );
        await Promise.all(sendPromises);

        input.value = ''; // Clear input on success
        statusEl.textContent = 'Message sent to all players!';
        setTimeout(() => statusEl.textContent = '', 4000);
      } catch (error) {
        statusEl.textContent = 'Error: Some messages may have failed to send.';
        console.error('Error sending group DM:', error);
      } finally {
        button.disabled = false;
        button.textContent = selectedPlayerIDs.size > 1 ? 'Send to All' : 'Send Message';
        // If it was a single chat, refresh the view
        if (selectedPlayerIDs.size === 1) {
          await renderPlayerActions();
        }
      }
    });
  }

  function enterLocationSelectMode() {
    if (isLocationSelectMode) return;

    isLocationSelectMode = true;
    const statusEl = document.getElementById('dm-send-status');
    if (statusEl) {
      statusEl.textContent = 'Click on the map to choose a target location...';
    }
    L.DomUtil.addClass(map.getContainer(), 'crosshair-cursor');

    map.once('click', async (e) => {
      const { lat, lng } = e.latlng;

      L.DomUtil.removeClass(map.getContainer(), 'crosshair-cursor');
      if (statusEl) statusEl.textContent = 'Sending location...';

      try {
        // We need to get obfuscated IDs for all selected players.
        const obfusPromises = Array.from(selectedPlayerIDs).map(playerID =>
          fetch('/api/obfuscate-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerID: playerID }),
          }).then(res => res.json())
        );
        const obfusDataArray = await Promise.all(obfusPromises);

        const sendPromises = obfusDataArray.map(obfusData =>
          fetch(`/api/target/${obfusData.obfuscatedID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng }),
          }).then(res => { if (!res.ok) throw new Error(`Failed for ${playerID}`) })
        );
        await Promise.all(sendPromises);
        if (statusEl) statusEl.textContent = 'Target location sent!';
      } catch (error) {
        if (statusEl) statusEl.textContent = 'Error sending location.';
        console.error('Error sending target location:', error);
      } finally {
        isLocationSelectMode = false;
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
      }
    });
  }

  async function updateMapData() {
    try {
      // Fetch player locations and target locations concurrently
      const [locationsRes, targetsRes] = await Promise.all([
        fetch('/api/locations'),
        fetch('/api/targets')
      ]);

      if (!locationsRes.ok) throw new Error(`Failed to fetch locations: ${locationsRes.statusText}`);
      if (!targetsRes.ok) throw new Error(`Failed to fetch targets: ${targetsRes.statusText}`);

      const locations = await locationsRes.json();
      const targets = await targetsRes.json();

      // --- 1. Clear all existing layers before redrawing ---
      mainMarkerGroup.clearLayers();
      legendItemsEl.innerHTML = '';
      Object.values(playerTargetLines).forEach(line => line.remove());

      // Keep track of which players were updated
      const updatedPlayerIDs = Object.keys(locations);

      for (const playerID of updatedPlayerIDs) {
        const loc = locations[playerID];
        const serverTimestamp = new Date(loc.timestamp);
        const clientTimestamp = new Date(loc.clientTimestamp);

        const lastPoll = formatTimeAgo(serverTimestamp);
        let lastLocationOrStatus;

        if (loc.status === 'OK') {
          lastLocationOrStatus = formatTimeAgo(clientTimestamp);
        } else {
          // For non-OK statuses, display the status text itself, styled for visibility.
          lastLocationOrStatus = `<span style="color: red; font-weight: bold;">${loc.status}</span>`;
        }

        // Render a marker as long as we have coordinates, even if they are stale.
        if (loc.lat && loc.lng) {
          const latLng = [loc.lat, loc.lng];
          const color = getColorForPlayer(playerID);

          // Determine if the icon should have the 'stale' class
          const iconClass = loc.status !== 'OK' ? 'stale-location' : '';

          // Create or update the marker
          const icon = createColoredIcon(color, iconClass);
          const marker = L.marker(latLng, { icon, type: 'player' }) // Add type option
            .bindPopup(`<b>${playerID}</b><br>Status: <span style="color: ${loc.status === 'OK' ? 'green' : 'red'}; font-weight: bold;">${loc.status}</span><br>Updated: ${serverTimestamp.toLocaleTimeString([], { hour12: false })}`)
            .on('click', (e) => handlePlayerSelection(playerID, e.originalEvent));

          // Store marker and add to the cluster group
          playerMarkers[playerID] = marker;
          mainMarkerGroup.addLayer(marker);
        }

        // Construct the new legend string
        const legendText = `${playerID} <small>(C ${lastPoll} L ${lastLocationOrStatus})</small>`;

        const color = getColorForPlayer(playerID);

        // Add entry to the legend
        const legendItem = document.createElement('div');
        legendItem.className = 'legend-item';
        if (selectedPlayerIDs.has(playerID)) {
          legendItem.classList.add('selected');
        }
        legendItem.dataset.playerId = playerID;
        legendItem.addEventListener('click', (e) => handlePlayerSelection(playerID, e));
        legendItem.innerHTML = ` 
          <div class="legend-color" style="background-color: ${color};"></div>
          <span>${legendText}</span>
        `;
        legendItemsEl.appendChild(legendItem);
      }

      // --- Draw Target Markers ---
      for (const playerID in targets) {
        const target = targets[playerID];
        const latLng = [target.lat, target.lng];
        const color = getColorForPlayer(playerID);
        const icon = createTargetIcon(color);

        const marker = L.marker(latLng, { icon, type: 'target', zIndexOffset: -100 }) // Add type and show behind players
          .bindPopup(`Target for <b>${playerID}</b><br>Set at: ${new Date(target.timestamp).toLocaleTimeString([], { hour12: false })}`)
        mainMarkerGroup.addLayer(marker);
        targetMarkers[playerID] = marker; // Store target marker
      }

      // --- Draw Lines from Players to Targets ---
      for (const playerID of updatedPlayerIDs) {
        // Check if this player has a target
        if (targets[playerID]) {
            const playerLatLng = [locations[playerID].lat, locations[playerID].lng];
            const targetLatLng = [targets[playerID].lat, targets[playerID].lng];

            const line = L.polyline([playerLatLng, targetLatLng], {
                color: getColorForPlayer(playerID),
                weight: 2,
                opacity: 0.6,
                dashArray: '5, 10'
            }).addTo(map);

            // Store the line so we can remove it in the next update
            playerTargetLines[playerID] = line;
        } else {
            delete playerTargetLines[playerID];
        }
      }

      // --- 2. Clean up internal tracking objects ---
      // Remove players from our tracking objects if they are no longer in the API response.
      for (const playerID in playerMarkers) {
        if (!updatedPlayerIDs.includes(playerID)) {
          // The visual elements are already gone thanks to clearLayers() and clear(),
          // so we just need to clean up our internal state.
          delete playerMarkers[playerID];
          delete targetMarkers[playerID]; // Also remove any associated target marker
          // Also remove from our color map so colors can be reused if players leave and rejoin
          // Note: This means a player rejoining might get a new color.
          // If colors must be permanent for the entire game session, remove this line.
          playerColorMap.delete(playerID);
        }
      }


    } catch (error) {
      console.error("Failed to fetch map data:", error);
    }
  }

  // Renamed for clarity
  const fetchAndDrawLocations = updateMapData;

  async function fetchAndDrawMessages() {
    try {
      const response = await fetch('/api/messages');
      if (!response.ok) {
        throw new Error(`Network response was not ok: ${response.statusText}`);
      }
      const messages = await response.json();
      messageFeedEl.innerHTML = ''; // Clear the feed

      if (!messages || messages.length === 0) {
        messageFeedEl.innerHTML = '<p>No messages yet.</p>';
        return;
      }

      messages.forEach(msg => {
        const msgEl = document.createElement('div');
        msgEl.className = `message-item ${msg.isRead ? '' : 'unread'}`;
        
        const playerColor = getColorForPlayer(msg.playerID);
        const sentTime = new Date(msg.timestamp).toLocaleTimeString([], { hour12: false });

        let readButtonHtml = '';
        if (!msg.isRead) {
          readButtonHtml = `<button class="mark-read-btn" data-message-id="${msg.id}">Mark as Read</button>`;
        }

        msgEl.innerHTML = `
          <div class="message-header">
            From: <strong style="color: ${playerColor};">${msg.playerID}</strong> at ${sentTime}
          </div>
          <div class="message-content">${msg.content}</div>
          ${readButtonHtml}
        `;
        messageFeedEl.appendChild(msgEl);
      });

    } catch (error) {
      console.error("Failed to fetch messages:", error);
      messageFeedEl.innerHTML = '<p>Error loading messages.</p>';
    }
  }

  // Event delegation for marking messages as read
  messageFeedEl.addEventListener('click', async (event) => {
    if (event.target.matches('.mark-read-btn')) {
      const messageId = event.target.dataset.messageId;
      event.target.disabled = true;
      await fetch(`/api/messages/read/${messageId}`, { method: 'POST' });
      await fetchAndDrawMessages(); // Refresh the message list
    }
  });

  // Fetch locations immediately and then every 5 seconds
  updateMapData();
  setInterval(updateMapData, 5000); // 5 seconds

  // Initial render of the actions panel
  renderPlayerActions();

  // Fetch messages immediately and then every 10 seconds
  fetchAndDrawMessages();
  setInterval(fetchAndDrawMessages, 10000); // 10 seconds
});