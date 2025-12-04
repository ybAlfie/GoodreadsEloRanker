// Global variable to store book data
// Each book object: {id, isbn, title, author, elo, matchups, active, cover_url, num_pages}
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
    const headers = ["ISBN", "Title", "Author", "ELO", "Matchups", "Active", "ID", "Cover_URL", "Number of Pages", "Additional Authors", "Average Rating", "Publisher", "Year Published", "Original Publication Year", "Date Added"];

    // Ensure each field is properly escaped
    const rows = books.map(b => [
        escapeCSV(b.isbn),
        escapeCSV(b.title),
        escapeCSV(b.author),
        Math.round(b.elo),
        b.matchups,
        b.active,
        escapeCSV(b.id),
        escapeCSV(b.cover_url),
        b.num_pages || '',
        escapeCSV(b.additional_authors),
        escapeCSV(b.average_rating),
        escapeCSV(b.publisher),
        escapeCSV(b.year_published),
        escapeCSV(b.original_publication_year),
        escapeCSV(b.date_added)
    ]);

    return [headers, ...rows].map(row => row.join(",")).join("\n");
}

// Make generateCSV available globally
window.generateCSV = generateCSV;

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
            complete: function (results) {
                try {
                    console.log('Parsing Goodreads CSV with', results.data.length, 'rows');

                    // Create maps using our book key function
                    const existingBooksMap = new Map();
                    existingBooks.forEach(book => {
                        const key = createBookKey(book);
                        existingBooksMap.set(key, book);
                    });

                    // Helper function to get number of pages from row, trying multiple column name variations
                    function getNumPages(row) {
                        const possibleColumns = [
                            "Number of Pages",
                            "Number Of Pages",
                            "Number of pages",
                            "Pages",
                            "Num Pages",
                            "Number Of Pages"
                        ];

                        for (const col of possibleColumns) {
                            const value = row[col];
                            if (value && value.toString().trim() !== '') {
                                const num = parseInt(value);
                                if (!isNaN(num) && num > 0) {
                                    return num;
                                }
                            }
                        }
                        return null;
                    }

                    const wantToReadBooks = results.data
                        .filter(row => row["Exclusive Shelf"] === "to-read")
                        .map(row => {
                            const key = createBookKey(row);
                            const existingBook = existingBooksMap.get(key);
                            const isbn = cleanISBN(row["ISBN13"]) || cleanISBN(row["ISBN"]);
                            const numPages = getNumPages(row);

                            console.log(`Processing: "${row["Title"]}" by ${row["Author"]}, Pages: ${numPages}, Key: ${key}, Found existing: ${!!existingBook}`);

                            if (existingBook) {
                                return {
                                    ...existingBook,
                                    title: row["Title"] || existingBook.title,
                                    author: row["Author"] || existingBook.author,
                                    isbn: isbn || existingBook.isbn,
                                    cover_url: existingBook.cover_url ||
                                        (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null),
                                    num_pages: numPages !== null ? numPages : (existingBook.num_pages || null),
                                    additional_authors: row["Additional Authors"] || existingBook.additional_authors,
                                    average_rating: row["Average Rating"] || existingBook.average_rating,
                                    publisher: row["Publisher"] || existingBook.publisher,
                                    year_published: row["Year Published"] || existingBook.year_published,
                                    original_publication_year: row["Original Publication Year"] || existingBook.original_publication_year,
                                    date_added: row["Date Added"] || existingBook.date_added,
                                    active: 1
                                };
                            }

                            return {
                                id: generateUniqueId(),
                                isbn: isbn,
                                title: row["Title"] || "Unknown Title",
                                author: row["Author"] || "Unknown Author",
                                cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null,
                                num_pages: numPages,
                                additional_authors: row["Additional Authors"] || '',
                                average_rating: row["Average Rating"] || '',
                                publisher: row["Publisher"] || '',
                                year_published: row["Year Published"] || '',
                                original_publication_year: row["Original Publication Year"] || '',
                                date_added: row["Date Added"] || '',
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
            error: function (error) {
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
            complete: function (results) {
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
                                    (row.ISBN ? `https://covers.openlibrary.org/b/isbn/${row.ISBN}-L.jpg` : null),
                                num_pages: row["Number of Pages"] || existingBook?.num_pages || null,
                                additional_authors: row["Additional Authors"] || existingBook?.additional_authors || '',
                                average_rating: row["Average Rating"] || existingBook?.average_rating || '',
                                publisher: row["Publisher"] || existingBook?.publisher || '',
                                year_published: row["Year Published"] || existingBook?.year_published || '',
                                original_publication_year: row["Original Publication Year"] || existingBook?.original_publication_year || '',
                                date_added: row["Date Added"] || existingBook?.date_added || ''
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
            error: function (error) {
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
function getNextMatchupData(options = {}) {
    books = JSON.parse(localStorage.getItem('books')) || [];
    let activeBooks = books.filter(b => b.active === 1);

    if (activeBooks.length < 2) return { book1: null, book2: null };

    // Apply limit filter if enabled
    if (options.limitEnabled && options.limitValue > 0) {
        // Sort by ELO descending to determine "Top" books
        // We clone the array to avoid mutating the original activeBooks order if it matters, 
        // though activeBooks is already a filtered copy.
        const sortedBooks = [...activeBooks].sort((a, b) => b.elo - a.elo);

        let limitCount = activeBooks.length;

        if (options.limitType === 'percent') {
            limitCount = Math.ceil(activeBooks.length * (options.limitValue / 100));
        } else {
            limitCount = parseInt(options.limitValue);
        }

        // Ensure at least 2 books
        limitCount = Math.max(2, Math.min(limitCount, activeBooks.length));

        // Filter activeBooks to only include those in the top set
        const topBooksSet = new Set(sortedBooks.slice(0, limitCount).map(b => b.id));
        activeBooks = activeBooks.filter(b => topBooksSet.has(b.id));
    }

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
