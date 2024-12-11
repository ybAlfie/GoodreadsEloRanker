// Global variable to store book data
// Each book object: {id, isbn, title, author, elo, matchups, active, cover_url}
let books = JSON.parse(localStorage.getItem('books')) || [];

// Save to localStorage
function saveBooks() {
    localStorage.setItem('books', JSON.stringify(books));
}

// Parse Goodreads CSV
async function parseGoodreadsCSV(file, existingBooks) {
    return new Promise((resolve) => {
        Papa.parse(file, {
            header: true,
            complete: function(results) {
                const goodreadsBooks = results.data
                    .filter(row => row["Bookshelves"] && row["Bookshelves"].toLowerCase().includes("to-read"))
                    .map(row => {
                        let isbn = row["ISBN13"] || row["ISBN"] || "";
                        isbn = isbn.replace(/"/g, '').trim();
                        if (isbn.startsWith('=')) isbn = isbn.substring(1);

                        return {
                            id: Date.now() + Math.random(),
                            title: row["Title"] || "Unknown Title",
                            author: row["Author"] || "Unknown Author",
                            isbn: isbn,
                            elo: 1200,
                            matchups: 0,
                            active: 1,
                            cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : ""
                        };
                    });

                const merged = mergeBooks(goodreadsBooks, existingBooks);
                resolve(merged);
            }
        });
    });
}

// Parse Rankings CSV
async function parseRankingsCSV(file, existingBooks) {
    return new Promise((resolve) => {
        Papa.parse(file, {
            header: true,
            complete: function(results) {
                const rankings = results.data.map(row => {
                    let isbn = row["ISBN"] || "";
                    isbn = isbn.replace(/"/g, '').trim();
                    if (isbn.startsWith('=')) isbn = isbn.substring(1);

                    return {
                        id: Date.now() + Math.random(),
                        isbn: isbn,
                        title: row["Title"] || "Unknown Title",
                        author: row["Author"] || "Unknown Author",
                        elo: parseInt(row["ELO"], 10) || 1200,
                        matchups: parseInt(row["Matchups"], 10) || 0,
                        active: parseInt(row["Active"], 10) || 1,
                        cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : ""
                    };
                });

                const merged = mergeRankings(rankings, existingBooks);
                resolve(merged);
            }
        });
    });
}

// Merge Goodreads books into existing books
function mergeBooks(goodreadsBooks, existingBooks) {
    goodreadsBooks.forEach(gb => {
        const existing = existingBooks.find(b => b.isbn === gb.isbn);
        if (existing) {
            // Update if needed
            existing.title = gb.title;
            existing.author = gb.author;
            existing.cover_url = gb.cover_url;
            existing.active = 1;
        } else {
            existingBooks.push(gb);
        }
    });
    return existingBooks;
}

// Merge Rankings into existing books
function mergeRankings(rankings, existingBooks) {
    rankings.forEach(rb => {
        const existing = existingBooks.find(b => b.isbn === rb.isbn);
        if (existing) {
            existing.elo = rb.elo;
            existing.matchups = rb.matchups;
            existing.active = rb.active;
            existing.title = rb.title;
            existing.author = rb.author;
            existing.cover_url = rb.cover_url;
        } else {
            existingBooks.push(rb);
        }
    });
    return existingBooks;
}

// Update a book's ELO
function updateBookElo(bookId, newElo) {
    const book = books.find(b => b.id === bookId);
    if (book) {
        book.elo = newElo;
        book.matchups = (book.matchups || 0) + 1;
    }
    // Also increment matchups for the loser in chooseWinner but we handle both after ELO calculation
    saveBooks();
}

// Get next matchup data
function getNextMatchupData() {
    books = JSON.parse(localStorage.getItem('books')) || [];
    const activeBooks = books.filter(b => b.active === 1);
    if (activeBooks.length < 2) return { book1: null, book2: null };

    // Prioritize books with fewer matchups
    const minMatchups = Math.min(...activeBooks.map(b => b.matchups));
    const underRanked = activeBooks.filter(b => b.matchups <= minMatchups + 2); // small leeway
    let pool = underRanked.length >= 2 ? underRanked : activeBooks;

    const shuffled = pool.sort(() => 0.5 - Math.random());
    const book1 = shuffled[0];
    const book2 = shuffled[1];

    // Increment their matchups count when displayed
    book1.matchups = book1.matchups || 0;
    book2.matchups = book2.matchups || 0;

    saveBooks();
    return { book1, book2 };
}
