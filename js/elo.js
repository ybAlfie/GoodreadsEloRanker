function rate1vs1(elo_winner, elo_loser, k=32) {
    const expected_winner = 1 / (1 + Math.pow(10, (elo_loser - elo_winner) / 400));
    const expected_loser = 1 / (1 + Math.pow(10, (elo_winner - elo_loser) / 400));

    const new_winner_elo = elo_winner + k * (1 - expected_winner);
    const new_loser_elo = elo_loser + k * (0 - expected_loser);

    return [new_winner_elo, new_loser_elo];
}
