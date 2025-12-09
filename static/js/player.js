// --- Reusable Helper Functions ---

/**
 * Wraps navigator.geolocation.getCurrentPosition in a promise for modern async/await usage.
 * @returns {Promise<GeolocationPosition>} A promise that resolves with the position or rejects with an error.
 */
function getGeolocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      // Create an error object that mimics the GeolocationPositionError
      reject({ code: 0, message: "Geolocation is not supported by this browser." });
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  });
}

async function runPlayerPage() {
  const statusEl = document.getElementById("status");
  const messageInputEl = document.getElementById("message-input");
  const sendMessageBtn = document.getElementById("send-message-button");
  const messageStatusEl = document.getElementById("message-status");
  const dmStatusEl = document.getElementById("dm-status");
  const targetStatusEl = document.getElementById("target-status");

  // Extract player ID from the URL path: /player/{id}
  const pathParts = window.location.pathname.split('/');
  const playerID = pathParts[pathParts.length - 1];

  if (!playerID) {
    statusEl.textContent = "Error: Could not determine Player ID from URL.";
    return;
  }

  statusEl.textContent = `Player ID: ${playerID}\nWaiting for location...`;

  // Store current position globally within the player's scope
  let currentPosition = null;
  // Keep track of what we've already notified the user about
  let lastNotifiedDmTimestamp = null;
  let lastNotifiedTargetTimestamp = null;

  // --- Notification Helpers ---
  async function requestNotificationPermission() {
    if (!("Notification" in window)) {
      console.log("This browser does not support desktop notification");
      return;
    }

    // If permission is already granted, we're good.
    if (Notification.permission === "granted") {
      return;
    } else if (Notification.permission !== "denied") {
      // Ask for permission and wait for the user's response.
      const permission = await Notification.requestPermission();
      console.log("Notification permission status:", permission);
    }
  }

  function showNotification(title, options) {
    // Only show notifications if permission has been granted.
    if (Notification.permission === "granted") {
      console.log("Attempting to create notification with title:", title);
      const notification = new Notification(title, { body: options.body });

      notification.onshow = function() {
        console.log('Notification shown successfully!');
      };
      notification.onerror = function(err) {
        // This is the key listener for debugging.
        console.error('Notification API error: ', err);
      };

    } else {
      console.log("Skipping notification, permission is:", Notification.permission);
    }
  }

  // Generic function to post a status update to the server.
  function postStatusUpdate(payload) {
    // Add the client timestamp to every update
    payload.clientTimestamp = new Date().toISOString();

    fetch(`/api/locations/${playerID}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }
      console.log("Status updated successfully:", payload.status);
    })
    .catch(error => {
      console.error("Error sending status update:", error);
      // Append to status element to show local error
      const statusEl = document.getElementById("status");
      statusEl.textContent += `\nError: Could not send update to server.`;
    });
  }

  // Function to get location and post it to the server
  async function updateLocation() {
    try {
      const position = await getGeolocation(); // Use the reusable helper
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      currentPosition = { lat, lng }; // Store the position

      const statusText = `Player ID: ${playerID}\nLat: ${lat.toFixed(5)}\nLng: ${lng.toFixed(5)}\nLast Connected: ${new Date().toLocaleTimeString([], { hour12: false })}`;
      statusEl.textContent = statusText;

      // Post the successful location to the backend
      postStatusUpdate({ lat, lng, status: "OK" });

    } catch (error) {
      let status = "UNAVAILABLE";
      if (error.code === error.PERMISSION_DENIED) status = "PERMISSION DENIED";
      if (error.code === 0) status = "NOT SUPPORTED"; // Custom code from our helper

      const statusText = `Player ID: ${playerID}\nStatus: Location ${status}\nLast Connected: ${new Date().toLocaleTimeString([], { hour12: false })}`;
      statusEl.textContent = statusText;
      console.error("Geolocation error:", error);
      postStatusUpdate({ status });
    }
  }

  // --- Messaging Logic ---

  // --- Calculation Helpers ---
  function toRad(deg) {
    return deg * Math.PI / 180;
  }

  function getDistanceAndBearing(pos1, pos2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = toRad(pos2.lat - pos1.lat);
    const dLon = toRad(pos2.lng - pos1.lng);
    const lat1 = toRad(pos1.lat);
    const lat2 = toRad(pos2.lat);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c; // in km

    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    let brng = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; // in degrees

    return { distance, bearing: brng };
  }

  function getCardinalDirection(bearing) {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return directions[Math.round(bearing / 45) % 8];
  }

  function updateTargetDisplay(target) {
    if (!currentPosition) {
      targetStatusEl.textContent = "Waiting for your location to calculate target...";
      return;
    }

    if (!target) {
      targetStatusEl.textContent = "No target assigned.";
      return;
    }

    const { distance, bearing } = getDistanceAndBearing(currentPosition, target);
    const distanceStr = distance < 1 ? `${(distance * 1000).toFixed(0)} m` : `${distance.toFixed(2)} km`;
    const cardinal = getCardinalDirection(bearing);

    targetStatusEl.textContent =
      `Target Code: ${target.fakeHash}\nDistance: ${distanceStr}\nBearing: ${bearing.toFixed(0)}° (${cardinal})`;
  }

  // Function to check the status of the last sent message
  async function checkMessageStatus() {
    try {
      const response = await fetch(`/api/messages/${playerID}`);
      if (response.status === 404) {
        messageStatusEl.innerHTML = "You haven't sent any messages yet.";
        return;
      }
      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }
      const data = await response.json();
      
      // Handle player's sent message status
      if (data.playerMessage) {
        let statusText = `<strong>Last Message Sent:</strong> "${data.playerMessage.content}"<br>`;
        if (data.playerMessage.isRead) {
          statusText += `<strong>Status:</strong> Read by game lead ✅`;
        } else {
          statusText += `<strong>Status:</strong> Sent, waiting for read receipt...`;
        }
        messageStatusEl.innerHTML = statusText;
      } else {
        messageStatusEl.innerHTML = "You haven't sent any messages yet.";
      }

      // Handle direct messages from game lead
      if (data.dm) {
        const dmTimestamp = new Date(data.dm.timestamp);
        dmStatusEl.innerHTML = `<strong>${dmTimestamp.toLocaleTimeString([], { hour12: false })}:</strong> ${data.dm.content}`;
        
        // If this is a new message, show a notification
        if (dmTimestamp.toISOString() !== lastNotifiedDmTimestamp) {
          showNotification("New Message from Game Lead", { body: data.dm.content });
          lastNotifiedDmTimestamp = dmTimestamp.toISOString();
          
          // Only blink if the message is recent (less than 1 minute old)
          const messageAge = new Date() - dmTimestamp; // Age in milliseconds
          if (messageAge < 60000) {
            dmStatusEl.classList.add('blinking-dm');
            setTimeout(() => {
              dmStatusEl.classList.remove('blinking-dm');
            }, 60000 - messageAge); // Stop blinking exactly 1 minute after it was sent
          }
        }
      }
      // Handle target location
      updateTargetDisplay(data.target);
      if (data.target) {
        const targetTimestamp = new Date(data.target.timestamp);
        // If this is a new or updated target, show a notification
        if (targetTimestamp.toISOString() !== lastNotifiedTargetTimestamp) {
          showNotification("New Target Assigned!", { body: `Target Code: ${data.target.fakeHash}` });
          lastNotifiedTargetTimestamp = targetTimestamp.toISOString();

          // Only blink if the target is recent (less than 1 minute old)
          const targetAge = new Date() - targetTimestamp; // Age in milliseconds
          if (targetAge < 60000) {
            targetStatusEl.classList.add('blinking-dm');
            // Stop blinking exactly 1 minute after it was assigned
            setTimeout(() => {
              targetStatusEl.classList.remove('blinking-dm');
            }, 60000 - targetAge);
          }
        }
      }

    } catch (error) {
      console.error("Error checking message status:", error);
      messageStatusEl.textContent = "Could not retrieve message status.";
    }
  }

  // Send message when button is clicked
  sendMessageBtn.addEventListener("click", async () => {
    const message = messageInputEl.value.trim();
    if (!message) {
      alert("Please enter a message.");
      return;
    }

    sendMessageBtn.disabled = true;
    sendMessageBtn.textContent = "Sending...";

    try {
      const response = await fetch(`/api/messages/${playerID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      messageInputEl.value = ""; // Clear input on success
      await checkMessageStatus(); // Immediately update status
    } catch (error) {
      console.error("Error sending message:", error);
      messageStatusEl.textContent = "Error: Could not send message.";
    } finally {
      sendMessageBtn.disabled = false;
      sendMessageBtn.textContent = "Send";
    }
  });

  // --- INITIALIZATION ---
  // First, ask for permission and wait for the user's response.
  await requestNotificationPermission();

  // Now that we have permission (or it's denied), start the periodic updates.
  updateLocation();
  setInterval(updateLocation, 10000); // 10 seconds

  checkMessageStatus();
  setInterval(checkMessageStatus, 15000); // Check every 15 seconds

  // Also, add a keypress listener for the message input for convenience
  messageInputEl.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessageBtn.click(); } });
}


function runTestPage() {
    const playerNameInput = document.getElementById('player-name');
    const startTestBtn = document.getElementById('start-test-btn');
    const resultsList = document.getElementById('results-checklist');

    const serverCheckEl = document.getElementById('server-check').querySelector('span');
    const locationCheckEl = document.getElementById('location-check').querySelector('span');
    const notificationCheckEl = document.getElementById('notification-check').querySelector('span');

    function updateChecklistItem(element, status, message) {
        element.textContent = message;
        element.className = status; // 'success', 'failure', or 'warning'
    }

    async function postTestResults(results) {
        try {
            const response = await fetch('/api/test-result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(results),
            });
            if (!response.ok) {
                throw new Error(`Server responded with status ${response.status}`);
            }
            console.log("Successfully posted test results to server.");
        } catch (error) {
            // This is a non-critical error, so we just log it and don't bother the user.
            console.error("Could not post test results to server:", error);
        }
    }


    async function runTests() {
        const playerName = playerNameInput.value.trim();
        if (!playerName) {
            alert("Please enter your name first.");
            return;
        }

        startTestBtn.disabled = true;
        startTestBtn.textContent = "Testing...";
        resultsList.style.display = 'block';

        const results = {
            playerName: playerName,
            notificationStatus: 'Testing',
            locationStatus: 'Testing',
            serverStatus: 'Testing',
        };
        // --- 1. Test Notification Permission ---
        // This is a simplified version for the test page.
        async function requestTestNotificationPermission() {
            if (!("Notification" in window)) {
                return 'unsupported';
            }
            return await Notification.requestPermission();
        }

        const permission = await requestTestNotificationPermission();
        if (permission === 'granted') {
            updateChecklistItem(notificationCheckEl, 'success', 'Granted ✅');
            results.notificationStatus = 'Granted';
            new Notification('DroppyDrop Test', { body: 'Notifications are working!' });
        } else if (permission === 'denied') {
            updateChecklistItem(notificationCheckEl, 'warning', `Refused ⚠️ - Notifications are useful but not required to play. You can enable them in browser settings if you change your mind.`);
            results.notificationStatus = 'Refused';
        } else if (permission === 'unsupported') {
            updateChecklistItem(notificationCheckEl, 'failure', 'Not supported by this browser ❌');
            results.notificationStatus = 'Unsupported';
        } else {
            updateChecklistItem(notificationCheckEl, 'warning', `Skipped ⚠️ - You can grant notification permission later if you wish.`);
            results.notificationStatus = 'Skipped';
        }

        // --- 2. Test Geolocation Permission ---
        try {
            await getGeolocation(); // Use the shared helper
            updateChecklistItem(locationCheckEl, 'success', 'Success ✅');
            results.locationStatus = 'Success';
        } catch (error) {
            if (error.code === error.PERMISSION_DENIED || error.code === 0) { // NOT SUPPORTED is code 0
                const statusMessage = error.code === 0 ? "NOT SUPPORTED" : "PERMISSION DENIED";
                updateChecklistItem(locationCheckEl, 'failure', `Failed ❌: ${statusMessage}. Please enable location services in your browser/system settings.`);
                results.locationStatus = statusMessage;
            } else { // This covers TIMEOUT or POSITION_UNAVAILABLE
                updateChecklistItem(locationCheckEl, 'warning', `Unavailable ⚠️: Could not get a location fix. Try moving to an area with a clearer view of the sky.`);
                results.locationStatus = 'Unavailable';
            }
        }

        // --- 3. Test Notification Permission ---
        const notificationPermission = await requestTestNotificationPermission();
        if (notificationPermission === 'granted') {
            updateChecklistItem(notificationCheckEl, 'success', 'Granted ✅');
            results.notificationStatus = 'Granted';
            new Notification('DroppyDrop Test', { body: 'Notifications are working!' });
        } else if (notificationPermission === 'denied') {
            updateChecklistItem(notificationCheckEl, 'warning', `Refused ⚠️ - Notifications are useful but not required. You can enable them in settings if you change your mind.`);
            results.notificationStatus = 'Refused';
        } else if (notificationPermission === 'unsupported') {
            updateChecklistItem(notificationCheckEl, 'warning', 'Not supported by this browser ⚠️');
            results.notificationStatus = 'Unsupported';
        } else { // 'default'
            updateChecklistItem(notificationCheckEl, 'warning', `Skipped ⚠️ - You can grant notification permission later if you wish.`);
            results.notificationStatus = 'Skipped';
        }

        // --- 4. Submit results and test server connection ---
        try {
            await postTestResults(results);
            // If the post succeeds, the server connection is good.
            updateChecklistItem(serverCheckEl, 'success', 'Success ✅');
            results.serverStatus = 'Success';
        } catch (error) {
            updateChecklistItem(serverCheckEl, 'failure', `Failed ❌: Could not submit results to the server.`);
            results.serverStatus = 'Failed';
            console.error("Server submission error:", error);
        }

        // Re-enable the button after all tests are complete.
        finally {
            startTestBtn.disabled = false;
            startTestBtn.textContent = "Run Test Again";
        }
    }

    startTestBtn.addEventListener('click', runTests);
    playerNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') runTests();
    });
}


// --- Main Entry Point ---
document.addEventListener("DOMContentLoaded", () => {
  // Check which page we are on by looking for a unique element
  if (document.getElementById('start-test-btn')) {
    // We are on the test page
    runTestPage();
  } else if (document.getElementById('status')) {
    // We are on the player page
    runPlayerPage();
  }
});