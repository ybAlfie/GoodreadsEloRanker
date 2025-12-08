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
    // Fix: Try each field individually to ensure we get a valid ISBN if one exists
    const isbn = cleanISBN(book.isbn) || cleanISBN(book.ISBN13) || cleanISBN(book.ISBN);
    if (isbn) return isbn;

    // Fallback to title+author combination
    const title = (book.title || book.Title || '').toLowerCase().trim();
    const author = (book.author || book.Author || '').toLowerCase().trim();
    return `${title}|${author}`;
}

// Helper to fetch cover from Google Books API
async function fetchCoverFromGoogleBooks(title, author, isbn) {
    // Strategy:
    // 1. If ISBN exists, try searching by ISBN.
    // 2. If that fails (or no ISBN), search by Title + Author.

    const queries = [];
    if (isbn) {
        queries.push(`isbn:${isbn}`);
    }
    if (title) {
        // Clean title for better search (remove series info in parenthesis)
        const cleanTitle = title.replace(/\s*\(.*?\)\s*/g, '').trim();
        queries.push(`intitle:${encodeURIComponent(cleanTitle)}${author ? `+inauthor:${encodeURIComponent(author)}` : ''}`);
    }

    for (const query of queries) {
        try {
            // Add a timeout to prevent hanging
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

            const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) continue;

            const data = await response.json();
            if (data.items && data.items.length > 0) {
                const volumeInfo = data.items[0].volumeInfo;
                if (volumeInfo.imageLinks) {
                    // Prefer thumbnail, fallback to smallThumbnail
                    // Google Books URLs often are http, upgrade to https
                    let url = volumeInfo.imageLinks.thumbnail || volumeInfo.imageLinks.smallThumbnail;
                    if (url) {
                        if (url.startsWith('http://')) {
                            url = url.replace('http://', 'https://');
                        }
                        // Google Books covers often have &edge=curl which adds a page curl effect. Remove it for a flat look.
                        url = url.replace('&edge=curl', '');
                        return url;
                    }
                }
            }
        } catch (e) {
            console.warn(`Failed to fetch cover from Google Books for query ${query}:`, e);
        }
    }

    return null;
}

// Parse Goodreads CSV
async function parseGoodreadsCSV(file, existingBooks, progressCallback) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: async function (results) {
                try {
                    console.log('Parsing Goodreads CSV with', results.data.length, 'rows');
                    if (results.errors && results.errors.length > 0) {
                        console.warn('CSV Parsing Errors:', results.errors);
                    }

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

                    // Identify books that are already read or currently reading
                    const booksInOtherShelves = new Set();
                    const activeShelves = new Set(['read', 'currently-reading']);

                    results.data.forEach(row => {
                        if (activeShelves.has(row["Exclusive Shelf"])) {
                            const title = (row["Title"] || '').toLowerCase().trim();
                            const author = (row["Author"] || '').toLowerCase().trim();
                            if (title && author) {
                                booksInOtherShelves.add(`${title}|${author}`);
                            }
                        }
                    });

                    const wantToReadBooks = [];
                    let processedCount = 0;

                    // Filter first to know total count for progress
                    const rowsToProcess = results.data.filter(row => row["Exclusive Shelf"] === "to-read");
                    const totalToProcess = rowsToProcess.length;

                    if (progressCallback) progressCallback(`Found ${totalToProcess} books to process...`);

                    // Process rows quickly without waiting for covers
                    for (let i = 0; i < rowsToProcess.length; i++) {
                        const row = rowsToProcess[i];

                        // Check if this book (by title/author) is already in read/currently-reading
                        const title = (row["Title"] || '').toLowerCase().trim();
                        const author = (row["Author"] || '').toLowerCase().trim();
                        const key = `${title}|${author}`;

                        if (booksInOtherShelves.has(key)) {
                            console.log(`Skipping "${row["Title"]}" because it is also in read/currently-reading`);
                            continue;
                        }

                        const bookKey = createBookKey(row);
                        const existingBook = existingBooksMap.get(bookKey);
                        const isbn = cleanISBN(row["ISBN13"]) || cleanISBN(row["ISBN"]);
                        const numPages = getNumPages(row);

                        if (existingBook) {
                            wantToReadBooks.push({
                                ...existingBook,
                                title: row["Title"] || existingBook.title,
                                author: row["Author"] || existingBook.author,
                                isbn: isbn || existingBook.isbn,
                                // Keep existing cover, or set OpenLibrary fallback if none exists and we have ISBN
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
                            });
                        } else {
                            // New book - Set OpenLibrary as placeholder if ISBN exists, else null
                            // We will fetch better covers in the background
                            let coverUrl = isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg` : null;

                            wantToReadBooks.push({
                                id: generateUniqueId(),
                                isbn: isbn,
                                title: row["Title"] || "Unknown Title",
                                author: row["Author"] || "Unknown Author",
                                cover_url: coverUrl,
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
                            });
                        }
                    }

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

// Background Cover Fetcher
let isFetchingCover = false;

async function fetchMissingCoverForBook(book) {
    if (!book || isFetchingCover) return false;

    // Only fetch if no cover or if it's an OpenLibrary cover (optional, but user wants Google Books priority)
    // For now, let's prioritize books with NO cover (null)
    if (book.cover_url && !book.cover_url.includes('covers.openlibrary.org')) return false;

    // If it has an OpenLibrary cover, we might want to keep it unless we are sure we can get a better one.
    // But the user specifically complained about missing covers for non-ISBN books.
    // Those will have cover_url = null. So let's focus on those first.
    if (book.cover_url !== null && book.cover_url !== undefined && book.cover_url !== '') return false;

    isFetchingCover = true;
    console.log(`Background fetching cover for: ${book.title}`);

    try {
        const newCoverUrl = await fetchCoverFromGoogleBooks(book.title, book.author, book.isbn);

        if (newCoverUrl) {
            // Update book in memory and localStorage
            const bookIndex = books.findIndex(b => b.id === book.id);
            if (bookIndex !== -1) {
                books[bookIndex].cover_url = newCoverUrl;
                saveBooks();
                console.log(`Updated cover for ${book.title}`);

                // Dispatch event so UI can update if needed
                window.dispatchEvent(new CustomEvent('bookCoverUpdated', {
                    detail: { bookId: book.id, coverUrl: newCoverUrl }
                }));
                return true;
            }
        }
    } catch (e) {
        console.warn(`Error background fetching for ${book.title}:`, e);
    } finally {
        isFetchingCover = false;
    }
    return false;
}

function startBackgroundCoverFetcher() {
    // Run every 2 seconds
    setInterval(async () => {
        if (isFetchingCover) return;

        // Find a random active book that needs a cover
        // Prioritize active books
        const activeBooks = books.filter(b => b.active === 1);
        const booksNeedingCover = activeBooks.filter(b => !b.cover_url);

        if (booksNeedingCover.length > 0) {
            const randomBook = booksNeedingCover[Math.floor(Math.random() * booksNeedingCover.length)];
            await fetchMissingCoverForBook(randomBook);
        }
    }, 2000);
}

// Start the background fetcher when app.js loads
// (It will run on any page that includes app.js)
startBackgroundCoverFetcher();

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
                        .map(row => {
                            const key = createBookKey(row);
                            const existingBook = existingBooksMap.get(key);

                            // Fix: Properly handle active=0 (use ?? instead of || to avoid treating 0 as falsy)
                            const active = row.Active !== undefined && row.Active !== ''
                                ? Number(row.Active)
                                : (existingBook?.active ?? 1);

                            return {
                                id: row.ID || existingBook?.id || generateUniqueId(),
                                isbn: row.ISBN || existingBook?.isbn || '',
                                title: row.Title || existingBook?.title || "Unknown Title",
                                author: row.Author || existingBook?.author || "Unknown Author",
                                elo: Number(row.ELO) || existingBook?.elo || 1500,
                                matchups: Number(row.Matchups) || existingBook?.matchups || 0,
                                active: active,
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

    // 1. Pick Book 1 (Prioritize lowest matchups)
    // Find the minimum number of matchups any book has
    const minMatchups = Math.min(...activeBooks.map(b => b.matchups || 0));

    // Define "low matchups" pool (within 2 of the minimum)
    // This ensures we focus on books that need ranking the most
    const lowMatchupPool = activeBooks.filter(b => (b.matchups || 0) <= minMatchups + 2);

    // If we have books in the low matchup pool, pick one randomly. Otherwise pick any active book.
    const pool1 = lowMatchupPool.length > 0 ? lowMatchupPool : activeBooks;
    const book1 = pool1[Math.floor(Math.random() * pool1.length)];

    // 2. Pick Book 2
    // Candidates are all other active books excluding Book 1
    let candidates = activeBooks.filter(b => b.id !== book1.id);

    // Constraint 1: Avoid "New vs New" loops
    // If Book 1 is "new" (low matchups) and the pool of such books is small (< 20),
    // try to pick an opponent that is established (has more matchups).
    // This satisfies the user request: "only one of the books need to come from that smaller pool"
    const NEW_BOOK_THRESHOLD = 5;
    const SMALL_POOL_SIZE = 20;

    if ((book1.matchups || 0) < NEW_BOOK_THRESHOLD && lowMatchupPool.length < SMALL_POOL_SIZE) {
        const establishedCandidates = candidates.filter(b => (b.matchups || 0) >= NEW_BOOK_THRESHOLD);
        // Only switch to established candidates if any exist
        if (establishedCandidates.length > 0) {
            candidates = establishedCandidates;
        }
    }

    // Constraint 2: Similar ELO
    // Sort candidates by ELO difference (closest to Book 1 first)
    candidates.sort((a, b) => Math.abs(a.elo - book1.elo) - Math.abs(b.elo - book1.elo));

    // Pick from the top N closest matches to add some variety and avoid exact repeats
    // We take the top 5 or top 10% of candidates, whichever is larger
    const topN = Math.max(5, Math.ceil(candidates.length * 0.1));
    const bestCandidates = candidates.slice(0, topN);

    const book2 = bestCandidates[Math.floor(Math.random() * bestCandidates.length)];

    // Initialize matchups count if undefined (does not increment)
    book1.matchups = book1.matchups || 0;
    book2.matchups = book2.matchups || 0;

    saveBooks();
    return { book1, book2 };
}

// Helper to ensure covers are fetched for the current matchup
async function ensureMatchupCovers(book1, book2) {
    if (book1) await fetchMissingCoverForBook(book1);
    if (book2) await fetchMissingCoverForBook(book2);
}
