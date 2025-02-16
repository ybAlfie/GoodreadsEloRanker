// Global variable to store book data
// Each book object: {id, isbn, title, author, elo, matchups, active, cover_url}
let books = JSON.parse(localStorage.getItem('books')) || [];

// Save to localStorage
function saveBooks() {
    localStorage.setItem('books', JSON.stringify(books));
}

// Parse Goodreads CSV
async function parseGoodreadsCSV(file, existingBooks) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            complete: function(results) {
                const existingBooksMap = new Map(
                    existingBooks.map(book => [book.isbn, book])
                );

                const wantToReadBooks = results.data
                    .filter(row => row["Exclusive Shelf"] === "to-read")
                    .map(row => {
                        let isbn = row["ISBN13"] || row["ISBN"] || generateUniqueId();
                        isbn = isbn.replace(/"/g, '').trim();
                        if (isbn.startsWith('=')) isbn = isbn.substring(1);
                        
                        const existingBook = existingBooksMap.get(isbn);

                        // If book exists, preserve its ELO, matchups, and ID
                        if (existingBook) {
                            return {
                                ...existingBook,
                                title: row["Title"] || "Unknown Title",
                                author: row["Author"] || "Unknown Author",
                                cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : "",
                                active: 1
                            };
                        }

                        // If it's a new book, create fresh entry with new ID
                        return {
                            id: Date.now() + Math.random(),  // Add unique ID for new books
                            isbn: isbn,
                            title: row["Title"] || "Unknown Title",
                            author: row["Author"] || "Unknown Author",
                            cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : "",
                            elo: 1500,
                            matchups: 0,
                            active: 1
                        };
                    });

                // Mark books not in new import as inactive
                existingBooks.forEach(book => {
                    if (!wantToReadBooks.find(b => b.isbn === book.isbn)) {
                        book.active = 0;
                    }
                });

                // Combine new books with existing inactive books
                const mergedBooks = [
                    ...wantToReadBooks,
                    ...existingBooks.filter(book => book.active === 0)
                ];

                // Update the global books variable
                books = mergedBooks;
                saveBooks();  // Save to localStorage

                resolve(mergedBooks);
            },
            error: function(error) {
                reject(error);
            }
        });
    });
}

// Parse Rankings CSV
async function parseRankingsCSV(file, existingBooks) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            complete: function(results) {
                const existingBooksMap = new Map(
                    existingBooks.map(book => [book.isbn, book])
                );

                const rankedBooks = results.data
                    .filter(row => row.ISBN && row.Title)
                    .map(row => {
                        const existingBook = existingBooksMap.get(row.ISBN);
                        
                        return {
                            isbn: row.ISBN,
                            title: row.Title,
                            author: row.Author,
                            elo: Number(row.ELO) || 1500,
                            matchups: Number(row.Matchups) || 0,
                            active: Number(row.Active) || 1,
                            cover_url: existingBook?.cover_url || null
                        };
                    });

                // Preserve any existing books not in rankings file
                const nonRankedBooks = existingBooks.filter(book => 
                    !rankedBooks.find(rb => rb.isbn === book.isbn)
                );

                resolve([...rankedBooks, ...nonRankedBooks]);
            },
            error: function(error) {
                reject(error);
            }
        });
    });
}

function generateUniqueId() {
    return 'temp_' + Math.random().toString(36).substr(2, 9);
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
