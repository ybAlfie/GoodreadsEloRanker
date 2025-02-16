// Global variable to store book data
// Each book object: {id, isbn, title, author, elo, matchups, active, cover_url}
let books = JSON.parse(localStorage.getItem('books')) || [];

// Save to localStorage
function saveBooks() {
    localStorage.setItem('books', JSON.stringify(books));
}

// Helper function to properly escape CSV values
function escapeCSV(value) {
    if (value == null) return '';
    value = value.toString();
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        // Escape quotes with double quotes and wrap in quotes
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

function generateCSV() {
    const books = JSON.parse(localStorage.getItem('books')) || [];
    const headers = ["ISBN", "Title", "Author", "ELO", "Matchups", "Active", "ID", "Cover_URL"];
    
    // Ensure each field is properly escaped
    const rows = books.map(b => [
        escapeCSV(b.isbn),
        escapeCSV(b.title),
        escapeCSV(b.author),
        Math.round(b.elo),
        b.matchups,
        b.active,
        escapeCSV(b.id),
        escapeCSV(b.cover_url)  // Add cover URL to export
    ]);

    return [headers, ...rows].map(row => row.join(",")).join("\n");
}

// Helper function to clean ISBN and handle empty cases
function cleanISBN(isbn) {
    if (!isbn) return '';
    return isbn.toString()
        .replace(/[="]/g, '')  // Remove quotes and = signs
        .replace(/[^0-9X]/gi, '')  // Remove non-ISBN characters
        .trim();
}

// Helper function to create a unique key for a book
function createBookKey(book) {
    // Create a key using ISBN or title+author if ISBN is missing
    const isbn = cleanISBN(book.isbn || book.ISBN13 || book.ISBN);
    if (isbn) return isbn;
    
    // Fallback to title+author combination
    const title = (book.title || book.Title || '').toLowerCase().trim();
    const author = (book.author || book.Author || '').toLowerCase().trim();
    return `${title}|${author}`;
}

// Parse Goodreads CSV
async function parseGoodreadsCSV(file, existingBooks) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: function(results) {
                try {
                    console.log('Parsing Goodreads CSV with', results.data.length, 'rows');
                    
                    // Create maps using our book key function
                    const existingBooksMap = new Map();
                    existingBooks.forEach(book => {
                        const key = createBookKey(book);
                        existingBooksMap.set(key, book);
                    });

                    const wantToReadBooks = results.data
                        .filter(row => row["Exclusive Shelf"] === "to-read")
                        .map(row => {
                            const key = createBookKey(row);
                            const existingBook = existingBooksMap.get(key);
                            const isbn = cleanISBN(row["ISBN13"]) || cleanISBN(row["ISBN"]);

                            console.log(`Processing: "${row["Title"]}" by ${row["Author"]}, Key: ${key}, Found existing: ${!!existingBook}`);

                            if (existingBook) {
                                return {
                                    ...existingBook,
                                    title: row["Title"] || existingBook.title,
                                    author: row["Author"] || existingBook.author,
                                    isbn: isbn || existingBook.isbn,
                                    cover_url: existingBook.cover_url || 
                                        (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null),
                                    active: 1
                                };
                            }

                            return {
                                id: generateUniqueId(),
                                isbn: isbn,
                                title: row["Title"] || "Unknown Title",
                                author: row["Author"] || "Unknown Author",
                                cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null,
                                elo: 1500,
                                matchups: 0,
                                active: 1
                            };
                        });

                    console.log('Found', wantToReadBooks.length, 'want to read books');

                    // Create a map of new books using our key function
                    const newBooksMap = new Map(
                        wantToReadBooks.map(book => [createBookKey(book), book])
                    );

                    // Mark existing books as inactive if not in new import
                    const inactiveBooks = existingBooks
                        .filter(book => {
                            const key = createBookKey(book);
                            const isInNewBooks = newBooksMap.has(key);
                            if (!isInNewBooks) {
                                console.log(`Marking as inactive: "${book.title}" by ${book.author}, Key: ${key}`);
                            }
                            return !isInNewBooks;
                        })
                        .map(book => ({ ...book, active: 0 }));

                    const mergedBooks = [...wantToReadBooks, ...inactiveBooks];
                    console.log('Final merged book count:', mergedBooks.length);

                    resolve(mergedBooks);
                } catch (error) {
                    console.error('Error processing Goodreads data:', error);
                    reject(error);
                }
            },
            error: function(error) {
                console.error('CSV parsing error:', error);
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
            skipEmptyLines: true,
            complete: function(results) {
                try {
                    console.log('Parsing rankings CSV with', results.data.length, 'rows');
                    
                    // Create maps using our book key function
                    const existingBooksMap = new Map();
                    existingBooks.forEach(book => {
                        const key = createBookKey(book);
                        existingBooksMap.set(key, book);
                    });

                    const rankedBooks = results.data
                        // Remove filter - we want ALL books, not just ones with ISBN
                        //.filter(row => row.ISBN)  // <-- This was the problem!
                        .map(row => {
                            const key = createBookKey(row);
                            const existingBook = existingBooksMap.get(key);
                            
                            return {
                                id: row.ID || existingBook?.id || generateUniqueId(),
                                isbn: row.ISBN || existingBook?.isbn || '',
                                title: row.Title || existingBook?.title || "Unknown Title",
                                author: row.Author || existingBook?.author || "Unknown Author",
                                elo: Number(row.ELO) || existingBook?.elo || 1500,
                                matchups: Number(row.Matchups) || existingBook?.matchups || 0,
                                active: Number(row.Active) || existingBook?.active || 1,
                                cover_url: row.Cover_URL || existingBook?.cover_url || 
                                    (row.ISBN ? `https://covers.openlibrary.org/b/isbn/${row.ISBN}-L.jpg` : null)
                            };
                        });

                    console.log('Rankings CSV rows:', results.data.length);
                    console.log('Processed ranked books:', rankedBooks.length);
                    console.log('Sample ranked book:', rankedBooks[0]);

                    resolve(rankedBooks);
                } catch (error) {
                    console.error('Error processing rankings:', error);
                    reject(error);
                }
            },
            error: function(error) {
                console.error('CSV parsing error:', error);
                reject(error);
            }
        });
    });
}

// Update ID generation to be more reliable
function generateUniqueId() {
    return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Update book ELO with better error handling
function updateBookElo(bookId, newElo) {
    const bookIndex = books.findIndex(b => b.id === bookId);
    if (bookIndex === -1) {
        console.error('Book not found:', bookId);
        return;
    }
    
    books[bookIndex] = {
        ...books[bookIndex],
        elo: newElo,
        matchups: (books[bookIndex].matchups || 0) + 1
    };
    
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
