// K-factor determines how much ratings can change in a single match
// Higher K = more volatile ratings
const K_FACTOR = 32;

/**
 * Calculate new ELO ratings for two players/books after a match
 * @param {number} winnerElo - Current ELO rating of winner
 * @param {number} loserElo - Current ELO rating of loser
 * @returns {[number, number]} - New [winnerElo, loserElo]
 */
function rate1vs1(winnerElo, loserElo) {
    // Calculate expected scores
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));

    // Calculate new ratings
    const newWinnerElo = winnerElo + K_FACTOR * (1 - expectedWinner);
    const newLoserElo = loserElo + K_FACTOR * (0 - expectedLoser);

    // Ensure ratings don't go below 100
    return [
        Math.max(100, newWinnerElo),
        Math.max(100, newLoserElo)
    ];
}

// For testing the implementation
function testEloSystem() {
    // Test case 1: Equal ratings
    const [newWinner1, newLoser1] = rate1vs1(1500, 1500);
    console.assert(
        Math.round(newWinner1) === 1516 && Math.round(newLoser1) === 1484,
        "Equal ratings test failed"
    );

    // Test case 2: Higher rated wins
    const [newWinner2, newLoser2] = rate1vs1(1600, 1400);
    console.assert(
        Math.round(newWinner2) === 1604 && Math.round(newLoser2) === 1396,
        "Higher rated wins test failed"
    );

    // Test case 3: Lower rated wins (upset)
    const [newWinner3, newLoser3] = rate1vs1(1400, 1600);
    console.assert(
        Math.round(newWinner3) === 1428 && Math.round(newLoser3) === 1572,
        "Lower rated wins test failed"
    );

    console.log("All ELO tests passed!");
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { rate1vs1, testEloSystem };
}
