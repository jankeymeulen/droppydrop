document.addEventListener("DOMContentLoaded", () => {
    const map = L.map('map').setView([50.8503, 4.3517], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    const legendItemsEl = document.getElementById('legend-items');
    const playerHistoryLayers = {}; // Stores Polyline layers by playerID
    const selectedPlayerIDs = new Set();

    // --- Color Generation (Same as gamelead.js for consistency) ---
    const playerColorMap = new Map();
    let colorCounter = 0;
    const goldenRatioConjugate = 0.618033988749895;

    function getColorForPlayer(playerID) {
        if (!playerColorMap.has(playerID)) {
            const hue = (colorCounter * goldenRatioConjugate * 360) % 360;
            colorCounter++;
            const color = `hsl(${hue}, 90%, 45%)`;
            playerColorMap.set(playerID, color);
        }
        return playerColorMap.get(playerID);
    }

    // --- Fetch Players and Build Legend ---
    async function init() {
        try {
            // We use the locations endpoint to get the list of all active players
            const response = await fetch('/api/locations');
            if (!response.ok) throw new Error('Failed to fetch players');
            const locations = await response.json();
            const playerIDs = Object.keys(locations).sort();

            legendItemsEl.innerHTML = '';
            if (playerIDs.length === 0) {
                legendItemsEl.innerHTML = '<p>No players found.</p>';
                return;
            }

            playerIDs.forEach(playerID => {
                const color = getColorForPlayer(playerID);
                const item = document.createElement('div');
                item.className = 'legend-item';
                item.dataset.playerId = playerID;
                item.innerHTML = `
                    <div class="legend-color" style="background-color: ${color};"></div>
                    <span>${playerID}</span>
                    <span class="loading-indicator" style="display: none;">Loading...</span>
                `;
                item.addEventListener('click', () => togglePlayerHistory(playerID, item));
                legendItemsEl.appendChild(item);
            });

        } catch (error) {
            console.error("Error initializing:", error);
            legendItemsEl.innerHTML = '<p style="color: red;">Error loading players.</p>';
        }
    }

    async function togglePlayerHistory(playerID, legendItem) {
        if (selectedPlayerIDs.has(playerID)) {
            // Deselect
            selectedPlayerIDs.delete(playerID);
            legendItem.classList.remove('selected');
            if (playerHistoryLayers[playerID]) {
                map.removeLayer(playerHistoryLayers[playerID]);
                delete playerHistoryLayers[playerID];
            }
        } else {
            // Select
            selectedPlayerIDs.add(playerID);
            legendItem.classList.add('selected');
            const loader = legendItem.querySelector('.loading-indicator');
            if (loader) loader.style.display = 'inline';

            await loadAndDrawHistory(playerID);
            
            if (loader) loader.style.display = 'none';
        }
    }

    async function loadAndDrawHistory(playerID) {
        try {
            const response = await fetch(`/api/history?player=${encodeURIComponent(playerID)}`);
            if (!response.ok) throw new Error('Failed to fetch history');
            const history = await response.json();

            if (!history || history.length === 0) {
                alert(`No history found for ${playerID}`);
                return;
            }

            const latLngs = history.map(entry => [entry.lat, entry.lng]);
            const color = getColorForPlayer(playerID);

            const polyline = L.polyline(latLngs, {
                color: color,
                weight: 4,
                opacity: 0.7
            }).addTo(map);

            // Add a small circle at the start and end
            L.circleMarker(latLngs[0], { radius: 4, color: color, fillColor: 'white', fillOpacity: 1 }).addTo(map);
            L.circleMarker(latLngs[latLngs.length - 1], { radius: 6, color: color, fillColor: color, fillOpacity: 1 }).addTo(map);

            playerHistoryLayers[playerID] = polyline;
            map.fitBounds(polyline.getBounds(), { padding: [50, 50] });

        } catch (error) {
            console.error(`Error loading history for ${playerID}:`, error);
            alert(`Could not load history for ${playerID}`);
        }
    }

    init();
});