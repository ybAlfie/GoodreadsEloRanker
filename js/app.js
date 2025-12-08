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
                            "Num Pages"
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

// Helper to check if an image is a 1x1 pixel placeholder or fails to load
function isImageBroken(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = function () {
            // OpenLibrary returns 1x1 pixel GIF for missing covers
            if (this.naturalWidth <= 1 && this.naturalHeight <= 1) {
                resolve(true);
            } else {
                resolve(false);
            }
        };
        img.onerror = function () {
            resolve(true);
        };
        img.src = url;
    });
}

async function fetchMissingCoverForBook(book) {
    if (!book || isFetchingCover) return false;

    // Check if we should fetch a better cover
    // 1. If no cover (null/empty) -> Fetch
    // 2. If OpenLibrary cover -> Check if it's broken (1x1). If broken -> Fetch. If good -> Keep.
    // 3. If Google Books cover -> Skip (already good)
    const hasNoCover = !book.cover_url;
    const hasOpenLibraryCover = book.cover_url && book.cover_url.includes('covers.openlibrary.org');

    if (!hasNoCover && !hasOpenLibraryCover) return false;

    // If it's an OpenLibrary cover, verify it's actually missing (1x1 pixel)
    if (hasOpenLibraryCover) {
        const isBroken = await isImageBroken(book.cover_url);
        if (!isBroken) {
            // It's a valid image, so we don't need to replace it
            return false;
        }
        console.log(`OpenLibrary cover for "${book.title}" is missing/placeholder, fetching from Google...`);
    }

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
        // Include books with no cover OR books with OpenLibrary covers (which might be broken 1x1 placeholders)
        const booksNeedingCover = activeBooks.filter(b =>
            !b.cover_url || (b.cover_url && b.cover_url.includes('covers.openlibrary.org'))
        );

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
                    console.log('Parsing Rankings CSV with', results.data.length, 'rows');

                    // Create a map of existing books by key
                    const existingBooksMap = new Map();
                    existingBooks.forEach(book => {
                        const key = createBookKey(book);
                        existingBooksMap.set(key, book);
                    });

                    // Update existing books with ranking data
                    results.data.forEach(row => {
                        const key = createBookKey(row);
                        const book = existingBooksMap.get(key);

                        if (book) {
                            book.elo = parseFloat(row["ELO"]) || 1500;
                            book.matchups = parseInt(row["Matchups"]) || 0;
                        }
                    });

                    resolve(existingBooks);
                } catch (error) {
                    console.error('Error processing Rankings data:', error);
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

// Generate CSV for export
function generateCSV(books) {
    const data = books.map(book => ({
        "Title": book.title,
        "Author": book.author,
        "ISBN": book.isbn,
        "ISBN13": book.isbn,
        "ELO": Math.round(book.elo),
        "Matchups": book.matchups,
        "Number of Pages": book.num_pages,
        "Additional Authors": book.additional_authors,
        "Average Rating": book.average_rating,
        "Publisher": book.publisher,
        "Year Published": book.year_published,
        "Original Publication Year": book.original_publication_year,
        "Date Added": book.date_added
    }));

    return Papa.unparse(data);
}

// Helper to clean ISBN
function cleanISBN(isbn) {
    if (!isbn) return null;
    // Remove non-numeric characters except 'X'
    return isbn.replace(/[^0-9X]/g, '');
}

// Helper to create a unique key for a book
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

// Helper to generate unique ID
function generateUniqueId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Update book ELO
function updateBookElo(bookId, newElo) {
    const bookIndex = books.findIndex(b => b.id === bookId);
    if (bookIndex !== -1) {
        books[bookIndex].elo = newElo;
        books[bookIndex].matchups = (books[bookIndex].matchups || 0) + 1;
        saveBooks();
    }
}

// Get next matchup data
function getNextMatchupData(options = {}) {
    let activeBooks = books.filter(b => b.active === 1);

    // Apply limit filter if enabled
    if (options.limitEnabled && options.limitValue) {
        // Sort by ELO descending
        const sortedBooks = [...activeBooks].sort((a, b) => b.elo - a.elo);

        let limit = parseInt(options.limitValue);
        if (options.limitType === 'percent') {
            limit = Math.ceil(sortedBooks.length * (limit / 100));
        }

        // Take top N books
        // We filter the activeBooks list to only include those in the top N
        // This allows the rest of the logic (lowest matchups, etc.) to work on the limited pool
        const topBooksSet = new Set(sortedBooks.slice(0, Math.max(2, limit)).map(b => b.id));
        activeBooks = activeBooks.filter(b => topBooksSet.has(b.id));
    }

    if (activeBooks.length < 2) return { book1: null, book2: null };

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

    return { book1, book2 };
}

// Helper to ensure covers are fetched for the current matchup
async function ensureMatchupCovers(book1, book2) {
    if (book1) await fetchMissingCoverForBook(book1);
    if (book2) await fetchMissingCoverForBook(book2);
}

// Fetch cover from Google Books
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

        // Fallback: Try title without subtitle (everything before colon)
        if (cleanTitle.includes(':')) {
            const shortTitle = cleanTitle.split(':')[0].trim();
            queries.push(`intitle:${encodeURIComponent(shortTitle)}${author ? `+inauthor:${encodeURIComponent(author)}` : ''}`);
        }
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

// Initialize books array
let books = JSON.parse(localStorage.getItem('books')) || [];

function saveBooks() {
    localStorage.setItem('books', JSON.stringify(books));
}
