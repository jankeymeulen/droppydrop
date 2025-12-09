document.addEventListener("DOMContentLoaded", () => {
    const generateBtn = document.getElementById('generate-json-btn');
    const playerNamesInput = document.getElementById('player-names-input');
    const jsonOutputContainer = document.getElementById('json-output-container');
    const jsonOutputEl = document.getElementById('json-output');
    const copyBtn = document.getElementById('copy-json-btn');

    async function generateJson() {
      const playerNames = playerNamesInput.value
        .split('\n')
        .map(name => name.trim())
        .filter(name => name.length > 0);

      if (playerNames.length === 0) {
        alert("Please enter at least one player name.");
        return;
      }

      generateBtn.disabled = true;
      generateBtn.textContent = 'Generating...';

      try {
        // Create an array of promises, one for each API call
        const obfusPromises = playerNames.map(playerName =>
          fetch('/api/obfuscate-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerID: playerName }),
          }).then(res => {
            if (!res.ok) throw new Error(`Failed for player ${playerName}`);
            return res.json();
          })
        );

        // Wait for all API calls to complete
        const obfusDataArray = await Promise.all(obfusPromises);

        // Map the results to the desired JSON structure
        const targetJson = obfusDataArray.map(data => ({
          playerName: data.playerID,
          obfuscatedURL: data.obfuscatedURL, // Add the URL for convenience
          target: {
            lat: 0.0, // Placeholder
            lng: 0.0  // Placeholder
          }
        }));

        // Display the JSON
        jsonOutputEl.value = JSON.stringify(targetJson, null, 2); // Pretty print
        jsonOutputContainer.style.display = 'block';

      } catch (error) {
        console.error('JSON Generation Error:', error);
        alert(error.message);
      } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate JSON Config';
      }
    }
  
    generateBtn.addEventListener('click', generateJson);

    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(jsonOutputEl.value);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 2000);
    });
  });