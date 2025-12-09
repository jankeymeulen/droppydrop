document.addEventListener("DOMContentLoaded", () => {
    const tableBody = document.getElementById('results-table-body');
    const lastUpdatedEl = document.getElementById('last-updated');
    const refreshBtn = document.getElementById('refresh-btn');

    function getStatusClass(status) {
        const s = status.toLowerCase();
        if (s === 'success' || s === 'granted') {
            return 'status-success';
        }
        if (s === 'refused' || s === 'skipped' || s === 'unavailable') {
            return 'status-warning';
        }
        // Covers 'failed', 'denied', 'unsupported', etc.
        return 'status-failure';
    }

    function formatTimeAgo(timestamp) {
        const now = new Date();
        const then = new Date(timestamp);
        const seconds = Math.floor((now - then) / 1000);

        if (seconds < 60) return "just now";
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        const days = Math.floor(hours / 24);
        return `${days} day${days > 1 ? 's' : ''} ago`;
    }

    async function fetchAndRenderResults() {
        lastUpdatedEl.textContent = 'Refreshing...';
        try {
            const response = await fetch('/api/test-results');
            if (!response.ok) {
                throw new Error(`Failed to fetch: ${response.statusText}`);
            }
            const results = await response.json();

            tableBody.innerHTML = ''; // Clear existing rows

            if (!results || results.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No test results have been recorded yet.</td></tr>';
                return;
            }

            results.forEach(result => {
                const row = document.createElement('tr');

                row.innerHTML = `
                    <td>${result.playerName}</td>
                    <td class="status-cell"><span class="${getStatusClass(result.locationStatus)}">${result.locationStatus}</span></td>
                    <td class="status-cell"><span class="${getStatusClass(result.notificationStatus)}">${result.notificationStatus}</span></td>
                    <td class="status-cell"><span class="status-success">Success</span></td>
                    <td>${formatTimeAgo(result.timestamp)}</td>
                `;
                tableBody.appendChild(row);
            });

        } catch (error) {
            console.error("Error fetching test results:", error);
            tableBody.innerHTML = `<tr><td colspan="5" style="color: red; text-align: center;">Error loading results: ${error.message}</td></tr>`;
        } finally {
            lastUpdatedEl.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
        }
    }

    refreshBtn.addEventListener('click', fetchAndRenderResults);

    // Initial load
    fetchAndRenderResults();

    // Auto-refresh every 30 seconds
    setInterval(fetchAndRenderResults, 30000);
});