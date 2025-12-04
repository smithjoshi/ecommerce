import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, addDoc, onSnapshot, collection, query, updateDoc, deleteDoc, getDoc, where, getDocs, orderBy, limit, serverTimestamp, runTransaction } from 'firebase/firestore';
import { Book, User, ArrowLeftRight, Clock, Scale, BarChart, AlertTriangle, Home, PlusCircle, Trash2, Edit2, Search } from 'lucide-react';

// --- GLOBAL FIREBASE/AUTH/APP VARIABLES (Provided by Canvas Environment) ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-lms-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Helper function to convert Firestore timestamp to Date object
const toDate = (timestamp) => timestamp?.toDate ? timestamp.toDate() : (timestamp instanceof Date ? timestamp : null);

// --- FINE CALCULATION CONSTANTS & UTILITIES ---
const FINE_RATE_PER_DAY = 0.50; // $0.50 per day
const BORROW_DAYS = 7; // Default due date is 7 days from borrow date

/**
 * Calculates the fine amount for a transaction.
 * @param {Date} dueDate - The official due date.
 * @param {Date} returnDate - The actual return date.
 * @returns {number} The calculated fine amount.
 */
const calculateFine = (dueDate, returnDate) => {
    if (!dueDate || !returnDate || returnDate <= dueDate) {
        return 0;
    }
    const timeDiff = returnDate.getTime() - dueDate.getTime();
    const daysLate = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
    return parseFloat((daysLate * FINE_RATE_PER_DAY).toFixed(2));
};

/**
 * Returns the Firestore Collection Reference for a given path
 */
const getCollectionRef = (db, collectionName) => {
    return collection(db, `artifacts/${appId}/public/data/${collectionName}`);
};

// --- Custom Components ---

const Card = ({ title, value, icon, className = "bg-white" }) => (
    <div className={`p-4 rounded-xl shadow-lg flex items-center justify-between transition-all duration-300 transform hover:scale-[1.02] ${className}`}>
        <div className="flex flex-col">
            <div className="text-sm font-medium text-gray-600">{title}</div>
            <div className="text-3xl font-bold text-gray-900">{value}</div>
        </div>
        <div className="p-3 bg-gray-100 rounded-full text-blue-600">
            {icon}
        </div>
    </div>
);

const Button = ({ children, onClick, variant = 'primary', className = '', disabled = false, icon }) => {
    let baseStyle = "px-4 py-2 font-semibold rounded-lg transition-colors duration-200 flex items-center justify-center space-x-2";
    let colorStyle = "";

    switch (variant) {
        case 'primary':
            colorStyle = "bg-blue-600 text-white hover:bg-blue-700 shadow-md";
            break;
        case 'secondary':
            colorStyle = "bg-gray-200 text-gray-800 hover:bg-gray-300";
            break;
        case 'danger':
            colorStyle = "bg-red-600 text-white hover:bg-red-700 shadow-md";
            break;
        case 'success':
            colorStyle = "bg-green-600 text-white hover:bg-green-700 shadow-md";
            break;
        default:
            colorStyle = "bg-blue-600 text-white hover:bg-blue-700 shadow-md";
    }

    if (disabled) {
        colorStyle = "bg-gray-400 text-gray-600 cursor-not-allowed";
    }

    return (
        <button
            onClick={onClick}
            className={`${baseStyle} ${colorStyle} ${className}`}
            disabled={disabled}
        >
            {icon && icon}
            <span>{children}</span>
        </button>
    );
};

// --- Library Management System (LMS) Components ---

// --- 1. Dashboard View ---

const Dashboard = ({ books, users, transactions }) => {
    const totalBooks = books.reduce((sum, book) => sum + book.totalCopies, 0);
    const availableBooks = books.reduce((sum, book) => sum + book.availableCopies, 0);
    const borrowedBooks = totalBooks - availableBooks;

    const overdueTransactions = transactions.filter(t => !t.returnDate && toDate(t.dueDate) < new Date());
    const totalFines = transactions.reduce((saum, t) => sum + (t.fineAmount || 0), 0);
    const totalStudents = users.filter(u => u.role === 'Student').length;
    const totalStaff = users.filter(u => u.role === 'Staff').length;

    return (
        <div className="space-y-6">
            <h2 className="text-3xl font-extrabold text-gray-900">Library Dashboard</h2>

            {/* General Overview Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                <Card title="Total Books" value={totalBooks} icon={<Book size={24} />} className="bg-blue-50" />
                <Card title="Available Copies" value={availableBooks} icon={<Book size={24} />} className="bg-green-50" />
                <Card title="Currently Borrowed" value={borrowedBooks} icon={<ArrowLeftRight size={24} />} className="bg-yellow-50" />
                <Card title="Total Users" value={users.length} icon={<User size={24} />} className="bg-indigo-50" />
            </div>

            {/* Financial and Risk Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                 <Card title="Overdue Transactions" value={overdueTransactions.length} icon={<AlertTriangle size={24} />} className="bg-red-50" />
                 <Card title="Total Fines Collected" value={`$${totalFines.toFixed(2)}`} icon={<Scale size={24} />} className="bg-purple-50" />
                 <Card title="Staff / Student Count" value={`${totalStaff} / ${totalStudents}`} icon={<User size={24} />} className="bg-pink-50" />
            </div>
            
        </div>
    );
};

// --- 2. Books Management View ---

const BookManagement = ({ db, books, bookCollection, loadBooks }) => {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isEditMode, setIsEditMode] = useState(false);
    const [currentBook, setCurrentBook] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');

    const [formData, setFormData] = useState({
        title: '', author: '', publisher: '', category: 'Fiction', totalCopies: 1, availableCopies: 1
    });

    const categories = useMemo(() => ['Fiction', 'Non-Fiction', 'Science', 'History', 'Technology', 'Art'], []);
    const filteredBooks = books.filter(book => 
        book.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        book.author.toLowerCase().includes(searchQuery.toLowerCase()) ||
        book.category.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: name === 'totalCopies' || name === 'availableCopies' ? parseInt(value) || 0 : value
        }));
    };

    const handleAddEdit = async (e) => {
        e.preventDefault();
        const data = { 
            ...formData, 
            totalCopies: parseInt(formData.totalCopies),
            availableCopies: parseInt(formData.availableCopies)
        };
        
        if (data.availableCopies > data.totalCopies) {
            console.error("Available copies cannot exceed total copies.");
            return;
        }

        try {
            if (isEditMode && currentBook?.id) {
                // Update existing book
                await setDoc(doc(bookCollection, currentBook.id), data, { merge: true });
                console.log("Book updated successfully!");
            } else {
                // Add new book
                await addDoc(bookCollection, data);
                console.log("Book added successfully!");
            }
            setIsModalOpen(false);
            resetForm();
            loadBooks(); // Refresh list
        } catch (error) {
            console.error("Error adding/updating document: ", error);
        }
    };

    const handleDelete = async (bookId) => {
        if (window.confirm("Are you sure you want to delete this book?")) {
            try {
                await deleteDoc(doc(bookCollection, bookId));
                console.log("Book deleted successfully!");
                loadBooks(); // Refresh list
            } catch (error) {
                console.error("Error deleting document: ", error);
            }
        }
    };

    const openModal = (book = null) => {
        if (book) {
            setIsEditMode(true);
            setCurrentBook(book);
            setFormData(book);
        } else {
            setIsEditMode(false);
            setCurrentBook(null);
            resetForm();
        }
        setIsModalOpen(true);
    };

    const resetForm = () => {
        setFormData({
            title: '', author: '', publisher: '', category: 'Fiction', totalCopies: 1, availableCopies: 1
        });
    }

    const Modal = ({ children, title }) => (
        isModalOpen && (
            <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center p-4 z-50">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6">
                    <h3 className="text-xl font-bold mb-4 border-b pb-2">{title}</h3>
                    {children}
                    <div className="mt-4 flex justify-end space-x-3">
                        <Button variant="secondary" onClick={() => setIsModalOpen(false)}>Cancel</Button>
                        <Button onClick={handleAddEdit}>{isEditMode ? 'Update Book' : 'Add Book'}</Button>
                    </div>
                </div>
            </div>
        )
    );

    return (
        <div className="space-y-6">
            <h2 className="text-3xl font-extrabold text-gray-900">Book Inventory Management</h2>
            <div className="flex justify-between items-center mb-6">
                <div className="relative w-full max-w-md">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                    <input
                        type="text"
                        placeholder="Search by title, author, or category..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full p-3 pl-10 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 transition-shadow"
                    />
                </div>
                <Button onClick={() => openModal()} icon={<PlusCircle size={20} />}>Add New Book</Button>
            </div>

            <div className="bg-white shadow-xl rounded-xl overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            {['Title', 'Author', 'Publisher', 'Category', 'Total', 'Available', 'Actions'].map(header => (
                                <th key={header} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{header}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {filteredBooks.map((book) => (
                            <tr key={book.id} className="hover:bg-blue-50/50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{book.title}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{book.author}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{book.publisher}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500"><span className="inline-flex px-2 text-xs leading-5 font-semibold rounded-full bg-indigo-100 text-indigo-800">{book.category}</span></td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{book.totalCopies}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-bold" style={{ color: book.availableCopies > 0 ? 'green' : 'red' }}>{book.availableCopies}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                                    <div className="flex space-x-2">
                                        <Button 
                                            variant="secondary" 
                                            className="p-2" 
                                            onClick={() => openModal(book)} 
                                            icon={<Edit2 size={16} />}
                                        />
                                        <Button 
                                            variant="danger" 
                                            className="p-2" 
                                            onClick={() => handleDelete(book.id)} 
                                            icon={<Trash2 size={16} />}
                                        />
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {filteredBooks.length === 0 && <p className="text-center py-8 text-gray-500">No books found matching your search criteria.</p>}
            </div>

            <Modal title={isEditMode ? 'Edit Book Details' : 'Add New Book'}>
                <form onSubmit={handleAddEdit} className="space-y-4">
                    {['title', 'author', 'publisher'].map(field => (
                        <input
                            key={field}
                            type="text"
                            name={field}
                            placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
                            value={formData[field]}
                            onChange={handleChange}
                            required
                            className="w-full p-2 border border-gray-300 rounded-lg"
                        />
                    ))}
                    <select
                        name="category"
                        value={formData.category}
                        onChange={handleChange}
                        required
                        className="w-full p-2 border border-gray-300 rounded-lg"
                    >
                        {categories.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                        ))}
                    </select>
                    <div className="flex space-x-4">
                        <input
                            type="number"
                            name="totalCopies"
                            placeholder="Total Copies"
                            value={formData.totalCopies}
                            onChange={handleChange}
                            min="1"
                            required
                            className="w-1/2 p-2 border border-gray-300 rounded-lg"
                        />
                        <input
                            type="number"
                            name="availableCopies"
                            placeholder="Available Copies"
                            value={formData.availableCopies}
                            onChange={handleChange}
                            min="0"
                            max={formData.totalCopies}
                            required
                            className="w-1/2 p-2 border border-gray-300 rounded-lg"
                        />
                    </div>
                </form>
            </Modal>
        </div>
    );
};

// --- 3. Users Management View ---

const UserManagement = ({ db, users, userCollection, loadUsers }) => {
    const [name, setName] = useState('');
    const [role, setRole] = useState('Student');

    const handleCreateUser = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;

        try {
            await addDoc(userCollection, {
                name: name.trim(),
                role: role, // 'Student' or 'Staff'
                isDefaulter: false,
                createdAt: serverTimestamp(),
            });
            setName('');
            console.log("User created successfully!");
            loadUsers(); // Refresh list
        } catch (error) {
            console.error("Error creating user: ", error);
        }
    };

    return (
        <div className="space-y-6">
            <h2 className="text-3xl font-extrabold text-gray-900">User Account Management</h2>

            <div className="bg-white p-6 rounded-xl shadow-lg">
                <h3 className="text-xl font-bold mb-4">Create New Account (Staff/Student)</h3>
                <form onSubmit={handleCreateUser} className="space-y-4 md:flex md:space-x-4 md:space-y-0 items-end">
                    <input
                        type="text"
                        placeholder="Full Name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                        className="flex-grow p-3 border border-gray-300 rounded-lg"
                    />
                    <select
                        value={role}
                        onChange={(e) => setRole(e.target.value)}
                        className="p-3 border border-gray-300 rounded-lg w-full md:w-auto"
                    >
                        <option value="Student">Student</option>
                        <option value="Staff">Staff</option>
                    </select>
                    <Button type="submit" className="w-full md:w-auto" icon={<PlusCircle size={20} />}>Create User</Button>
                </form>
            </div>

            <div className="bg-white shadow-xl rounded-xl overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            {['ID', 'Name', 'Role', 'Status'].map(header => (
                                <th key={header} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{header}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {users.map((user) => (
                            <tr key={user.id} className="hover:bg-indigo-50/50 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap text-xs text-gray-400">{user.id}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{user.name}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                    <span className={`inline-flex px-2 text-xs leading-5 font-semibold rounded-full ${user.role === 'Staff' ? 'bg-yellow-100 text-yellow-800' : 'bg-blue-100 text-blue-800'}`}>
                                        {user.role}
                                    </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm">
                                    <span className={`inline-flex px-2 text-xs leading-5 font-semibold rounded-full ${user.isDefaulter ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`}>
                                        {user.isDefaulter ? 'Defaulter' : 'Good Standing'}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {users.length === 0 && <p className="text-center py-8 text-gray-500">No users found.</p>}
            </div>
        </div>
    );
};

// --- 4. Transaction View (Borrow & Return) ---

const TransactionManagement = ({ db, bookCollection, transactionCollection, loadTransactions, books, users }) => {
    const [selectedUserId, setSelectedUserId] = useState('');
    const [selectedBookId, setSelectedBookId] = useState('');
    const [transactions, setTransactions] = useState([]); // Local state for transaction display
    const [searchQuery, setSearchQuery] = useState('');

    const loadLocalTransactions = useCallback(() => {
        // Simple listener for real-time transaction data
        const q = query(transactionCollection, orderBy('borrowDate', 'desc'));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const txns = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                borrowDate: toDate(doc.data().borrowDate),
                dueDate: toDate(doc.data().dueDate),
                returnDate: toDate(doc.data().returnDate),
            }));
            setTransactions(txns);
            loadTransactions(); // Call the parent function to update the global list
        }, (error) => {
            console.error("Error fetching transactions: ", error);
        });
        return unsubscribe;
    }, [transactionCollection, loadTransactions]);

    useEffect(() => {
        const unsubscribe = loadLocalTransactions();
        return () => unsubscribe();
    }, [loadLocalTransactions]);

    const getBookTitle = (id) => books.find(b => b.id === id)?.title || `[Book ID: ${id}]`;
    const getUserName = (id) => users.find(u => u.id === id)?.name || `[User ID: ${id}]`;
    
    // Filtered lists for selection
    const availableBooks = books.filter(b => b.availableCopies > 0);
    const filteredUsers = users.filter(u => u.name.toLowerCase().includes(searchQuery.toLowerCase()) || u.id.includes(searchQuery));

    const handleBorrow = async (e) => {
        e.preventDefault();
        if (!selectedUserId || !selectedBookId) return;

        const selectedBook = books.find(b => b.id === selectedBookId);
        if (!selectedBook || selectedBook.availableCopies < 1) {
            console.error("Book not available for borrow.");
            return;
        }

        const borrowDate = new Date();
        const dueDate = new Date();
        dueDate.setDate(borrowDate.getDate() + BORROW_DAYS);

        try {
            await runTransaction(db, async (t) => {
                // 1. Update Book Availability
                const bookRef = doc(bookCollection, selectedBookId);
                const bookDoc = await t.get(bookRef);
                const newAvailableCopies = bookDoc.data().availableCopies - 1;
                t.update(bookRef, { availableCopies: newAvailableCopies });

                // 2. Create Transaction Record
                t.set(doc(transactionCollection), {
                    bookId: selectedBookId,
                    userId: selectedUserId,
                    borrowDate: serverTimestamp(),
                    dueDate: dueDate,
                    returnDate: null,
                    fineAmount: 0,
                });
            });

            setSelectedBookId('');
            setSelectedUserId('');
            console.log("Book successfully borrowed.");
        } catch (error) {
            console.error("Transaction failed: ", error);
        }
    };

    const handleReturn = async (txn) => {
        if (txn.returnDate) return; // Already returned

        const returnDate = new Date();
        const fine = calculateFine(txn.dueDate, returnDate);

        try {
            await runTransaction(db, async (t) => {
                // 1. Update Book Availability
                const bookRef = doc(bookCollection, txn.bookId);
                const bookDoc = await t.get(bookRef);
                const newAvailableCopies = bookDoc.data().availableCopies + 1;
                t.update(bookRef, { availableCopies: newAvailableCopies });

                // 2. Update Transaction Record
                const txnRef = doc(transactionCollection, txn.id);
                t.update(txnRef, {
                    returnDate: serverTimestamp(),
                    fineAmount: fine,
                });

                // 3. (Simplified) Check and Update Defaulter Status - Done in Reports for efficiency
            });

            console.log(`Book successfully returned. Fine: $${fine.toFixed(2)}.`);
        } catch (error) {
            console.error("Transaction failed: ", error);
        }
    };
    
    const openTransactions = transactions.filter(t => !t.returnDate);
    const closedTransactions = transactions.filter(t => t.returnDate);

    return (
        <div className="space-y-8">
            <h2 className="text-3xl font-extrabold text-gray-900">Transaction Desk</h2>

            {/* Borrow Form */}
            <div className="bg-white p-6 rounded-xl shadow-lg">
                <h3 className="text-xl font-bold mb-4 flex items-center space-x-2"><ArrowLeftRight size={20}/> New Borrow (Withdraw)</h3>
                <form onSubmit={handleBorrow} className="space-y-4 md:flex md:space-x-4 md:space-y-0 items-end">
                    <div className="flex flex-col w-full">
                        <label className="text-sm font-medium text-gray-700 mb-1">Select User</label>
                        <select
                            value={selectedUserId}
                            onChange={(e) => setSelectedUserId(e.target.value)}
                            required
                            className="p-3 border border-gray-300 rounded-lg w-full"
                        >
                            <option value="">-- Select Student or Staff --</option>
                            {users.map(user => (
                                <option key={user.id} value={user.id}>{user.name} ({user.role}) - ID: {user.id.substring(0, 8)}...</option>
                            ))}
                        </select>
                    </div>
                    <div className="flex flex-col w-full">
                        <label className="text-sm font-medium text-gray-700 mb-1">Select Book</label>
                        <select
                            value={selectedBookId}
                            onChange={(e) => setSelectedBookId(e.target.value)}
                            required
                            className="p-3 border border-gray-300 rounded-lg w-full"
                        >
                            <option value="">-- Select Available Book --</option>
                            {availableBooks.map(book => (
                                <option key={book.id} value={book.id}>{book.title} by {book.author} ({book.availableCopies} available)</option>
                            ))}
                        </select>
                    </div>
                    <Button type="submit" disabled={!selectedUserId || !selectedBookId} className="w-full md:w-auto" icon={<PlusCircle size={20} />}>Borrow Book</Button>
                </form>
            </div>

            {/* Open Transactions (Returns) */}
            <div className="bg-white shadow-xl rounded-xl overflow-hidden">
                <div className="p-6">
                    <h3 className="text-xl font-bold mb-4 flex items-center space-x-2"><Clock size={20}/> Open Transactions (Awaiting Return)</h3>
                    {openTransactions.length === 0 && <p className="text-center py-4 text-gray-500">No books are currently borrowed.</p>}
                </div>
                {openTransactions.length > 0 && (
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                {['Book', 'User', 'Borrow Date', 'Due Date', 'Status', 'Action'].map(header => (
                                    <th key={header} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{header}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {openTransactions.map((txn) => {
                                const isOverdue = txn.dueDate < new Date();
                                return (
                                    <tr key={txn.id} className="hover:bg-red-50/50 transition-colors">
                                        <td className="px-6 py-4 text-sm font-medium text-gray-900">{getBookTitle(txn.bookId)}</td>
                                        <td className="px-6 py-4 text-sm text-gray-500">{getUserName(txn.userId)}</td>
                                        <td className="px-6 py-4 text-sm text-gray-500">{txn.borrowDate?.toLocaleDateString()}</td>
                                        <td className="px-6 py-4 text-sm font-semibold" style={{ color: isOverdue ? 'red' : 'green' }}>{txn.dueDate?.toLocaleDateString()}</td>
                                        <td className="px-6 py-4 text-sm">
                                            <span className={`inline-flex px-2 text-xs leading-5 font-semibold rounded-full ${isOverdue ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}>
                                                {isOverdue ? 'OVERDUE' : 'Borrowed'}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-sm">
                                            <Button variant="success" className="text-xs py-1" onClick={() => handleReturn(txn)}>Return Book</Button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Closed Transactions */}
             <div className="bg-white shadow-xl rounded-xl overflow-hidden">
                <div className="p-6">
                    <h3 className="text-xl font-bold mb-4 flex items-center space-x-2">Closed Transactions (Returned)</h3>
                </div>
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            {['Book', 'User', 'Return Date', 'Fine'].map(header => (
                                <th key={header} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{header}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {closedTransactions.slice(0, 10).map((txn) => (
                            <tr key={txn.id} className="hover:bg-gray-50 transition-colors">
                                <td className="px-6 py-4 text-sm font-medium text-gray-900">{getBookTitle(txn.bookId)}</td>
                                <td className="px-6 py-4 text-sm text-gray-500">{getUserName(txn.userId)}</td>
                                <td className="px-6 py-4 text-sm text-gray-500">{txn.returnDate?.toLocaleDateString()}</td>
                                <td className="px-6 py-4 text-sm font-bold" style={{ color: txn.fineAmount > 0 ? 'red' : 'green' }}>${txn.fineAmount.toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {closedTransactions.length === 0 && <p className="text-center py-8 text-gray-500">No completed returns yet.</p>}
            </div>
        </div>
    );
};


// --- 5. Reports View ---

const Reports = ({ books, users, transactions, userCollection }) => {
    // Helper to get month/year key
    const getMonthYear = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const MIN_LATE_COUNT_FOR_DEFAULTER = 2; // Threshold for "regular" defaulter

    // --- Report V: Generate report based on author, publisher, category ---
    const bookReports = useMemo(() => {
        const counts = { author: {}, publisher: {}, category: {} };

        transactions.forEach(txn => {
            const book = books.find(b => b.id === txn.bookId);
            if (book) {
                // By Author
                counts.author[book.author] = (counts.author[book.author] || 0) + 1;
                // By Publisher
                counts.publisher[book.publisher] = (counts.publisher[book.publisher] || 0) + 1;
                // By Category
                counts.category[book.category] = (counts.category[book.category] || 0) + 1;
            }
        });
        
        const formatReport = (data) => Object.entries(data).sort(([, a], [, b]) => b - a);
        
        return {
            author: formatReport(counts.author),
            publisher: formatReport(counts.publisher),
            category: formatReport(counts.category),
        };
    }, [books, transactions]);


    // --- Report VI: Generate monthly usage report of students and staff ---
    const monthlyUsageReport = useMemo(() => {
        const usage = {};
        transactions.forEach(txn => {
            const user = users.find(u => u.id === txn.userId);
            if (!user) return;
            
            const monthYear = getMonthYear(txn.borrowDate);
            usage[monthYear] = usage[monthYear] || { Student: 0, Staff: 0, Total: 0 };
            
            usage[monthYear][user.role] = (usage[monthYear][user.role] || 0) + 1;
            usage[monthYear].Total += 1;
        });
        
        return Object.entries(usage)
            .sort(([a], [b]) => b.localeCompare(a)); // Sort by month descending
    }, [transactions, users]);


    // --- Report VII: Generate regular defaulters who return books after due date (Calculation) ---
    const userLateCounts = useMemo(() => {
        const counts = {};
        transactions.forEach(txn => {
            if (txn.fineAmount > 0) {
                counts[txn.userId] = (counts[txn.userId] || 0) + 1;
            }
        });
        return counts;
    }, [transactions]);
    
    const defaultersReport = useMemo(() => {
        const regularDefaulters = users.filter(user => userLateCounts[user.id] >= MIN_LATE_COUNT_FOR_DEFAULTER);
        
        return regularDefaulters.map(u => ({
            ...u,
            lateCount: userLateCounts[u.id]
        })).sort((a, b) => b.lateCount - a.lateCount);
    }, [users, userLateCounts]);


    // --- Report VII: Update Defaulter Status in Firestore (Dedicated useEffect for Hook Compliance) ---
    useEffect(() => {
        if (!userCollection) return;
        
        const updateDefaulterStatus = async () => {
             const defaulterIds = new Set(defaultersReport.map(u => u.id));

             for (const user of users) {
                 const isCurrentlyDefaulter = defaulterIds.has(user.id);
                 if (user.isDefaulter !== isCurrentlyDefaulter) {
                     try {
                         await updateDoc(doc(userCollection, user.id), { isDefaulter: isCurrentlyDefaulter });
                     } catch (e) {
                         console.error("Failed to update defaulter status for user:", user.id, e);
                     }
                 }
             }
        };

        // Only run this update if the reports change, ensuring we don't spam Firestore
        if (defaultersReport.length > 0 || users.some(u => u.isDefaulter)) {
            updateDefaulterStatus();
        }
    }, [defaultersReport, users, userCollection]);
    
    
    const ReportTable = ({ title, headers, data, renderRow }) => (
        <div className="bg-white p-6 rounded-xl shadow-lg">
            <h3 className="text-xl font-bold mb-4">{title}</h3>
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            {headers.map(header => (
                                <th key={header} className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{header}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {data.length > 0 ? data.map(renderRow) : (
                             <tr><td colSpan={headers.length} className="text-center py-4 text-gray-500">No data available for this report.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );

    return (
        <div className="space-y-8">
            <h2 className="text-3xl font-extrabold text-gray-900 flex items-center space-x-2"><BarChart size={28}/> Library Reports</h2>
            
            {/* Report VII: Defaulters */}
            <ReportTable
                title="Regular Defaulters (Late Returns > 1)"
                headers={['User Name', 'Role', 'Total Late Returns']}
                data={defaultersReport}
                renderRow={({ id, name, role, lateCount }) => (
                    <tr key={id} className="hover:bg-red-50/50 transition-colors">
                        <td className="px-6 py-4 text-sm font-medium text-red-900">{name}</td>
                        <td className="px-6 py-4 text-sm text-red-700">{role}</td>
                        <td className="px-6 py-4 text-sm font-bold text-red-600">{lateCount}</td>
                    </tr>
                )}
            />

            {/* Report VI: Monthly Usage */}
            <ReportTable
                title="Monthly Usage Report"
                headers={['Month/Year', 'Student Borrows', 'Staff Borrows', 'Total Borrows']}
                data={monthlyUsageReport}
                renderRow={([monthYear, data]) => (
                    <tr key={monthYear} className="hover:bg-blue-50/50 transition-colors">
                        <td className="px-6 py-4 text-sm font-medium text-gray-900">{monthYear}</td>
                        <td className="px-6 py-4 text-sm text-gray-700">{data.Student}</td>
                        <td className="px-6 py-4 text-sm text-gray-700">{data.Staff}</td>
                        <td className="px-6 py-4 text-sm font-bold text-blue-600">{data.Total}</td>
                    </tr>
                )}
            />

            {/* Report V: Book Analytics (Category) */}
            <ReportTable
                title="Book Usage by Category"
                headers={['Category', 'Total Borrows']}
                data={bookReports.category}
                renderRow={([name, count]) => (
                    <tr key={name} className="hover:bg-indigo-50/50 transition-colors">
                        <td className="px-6 py-4 text-sm font-medium text-gray-900">{name}</td>
                        <td className="px-6 py-4 text-sm font-bold text-indigo-600">{count}</td>
                    </tr>
                )}
            />
            
            {/* Report V: Book Analytics (Author/Publisher) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 <ReportTable
                    title="Top Authors by Borrows"
                    headers={['Author', 'Borrows']}
                    data={bookReports.author.slice(0, 5)}
                    renderRow={([name, count]) => (
                        <tr key={name} className="hover:bg-green-50/50 transition-colors">
                            <td className="px-6 py-4 text-sm font-medium text-gray-900">{name}</td>
                            <td className="px-6 py-4 text-sm font-bold text-green-600">{count}</td>
                        </tr>
                    )}
                />
                 <ReportTable
                    title="Top Publishers by Borrows"
                    headers={['Publisher', 'Borrows']}
                    data={bookReports.publisher.slice(0, 5)}
                    renderRow={([name, count]) => (
                        <tr key={name} className="hover:bg-yellow-50/50 transition-colors">
                            <td className="px-6 py-4 text-sm font-medium text-gray-900">{name}</td>
                            <td className="px-6 py-4 text-sm font-bold text-yellow-600">{count}</td>
                        </tr>
                    )}
                />
            </div>

        </div>
    );
};


// --- MAIN APP COMPONENT ---

const App = () => {
    const [authReady, setAuthReady] = useState(false);
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [view, setView] = useState('Dashboard'); // Controls navigation

    // Data States
    const [books, setBooks] = useState([]);
    const [users, setUsers] = useState([]);
    const [transactions, setTransactions] = useState([]);

    // Firestore Collection References (Memoized)
    const bookCollection = useMemo(() => db ? getCollectionRef(db, 'books') : null, [db]);
    const userCollection = useMemo(() => db ? getCollectionRef(db, 'users') : null, [db]);
    const transactionCollection = useMemo(() => db ? getCollectionRef(db, 'transactions') : null, [db]);


    // --- 1. FIREBASE INITIALIZATION AND AUTHENTICATION ---
    useEffect(() => {
        if (!firebaseConfig) {
            console.error("Firebase config is missing.");
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const firebaseAuth = getAuth(app);
            setDb(firestore);
            setAuth(firebaseAuth);

            // Authentication listener
            const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
                if (user) {
                    setUserId(user.uid);
                    setAuthReady(true);
                } else {
                    // Initial sign-in logic (using custom token if available, otherwise anonymous)
                    try {
                        if (initialAuthToken) {
                            await signInWithCustomToken(firebaseAuth, initialAuthToken);
                        } else {
                            await signInAnonymously(firebaseAuth);
                        }
                    } catch (error) {
                        console.error("Authentication failed: ", error);
                        setAuthReady(true); // Still set ready even if anonymous sign-in failed
                    }
                }
            });

            return () => unsubscribe();
        } catch (e) {
            console.error("Firebase initialization failed:", e);
        }
    }, []);

    // --- 2. DATA LOADERS ---

    const loadBooks = useCallback(() => {
        if (!authReady || !bookCollection) return;
        const q = query(bookCollection);
        const unsubscribe = onSnapshot(q, (snapshot) => {
            setBooks(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }, (error) => {
            console.error("Error fetching books: ", error);
        });
        return unsubscribe;
    }, [authReady, bookCollection]);

    const loadUsers = useCallback(() => {
        if (!authReady || !userCollection) return;
        const q = query(userCollection);
        const unsubscribe = onSnapshot(q, (snapshot) => {
            setUsers(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }, (error) => {
            console.error("Error fetching users: ", error);
        });
        return unsubscribe;
    }, [authReady, userCollection]);

    const loadTransactions = useCallback(() => {
        if (!authReady || !transactionCollection) return;
        // Fetch all transactions for comprehensive reporting
        const q = query(transactionCollection);
        const unsubscribe = onSnapshot(q, (snapshot) => {
            setTransactions(snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                borrowDate: toDate(doc.data().borrowDate),
                dueDate: toDate(doc.data().dueDate),
                returnDate: toDate(doc.data().returnDate),
            })));
        }, (error) => {
            console.error("Error fetching transactions: ", error);
        });
        return unsubscribe;
    }, [authReady, transactionCollection]);
    
    // --- Initial Data Fetching Effect ---
    useEffect(() => {
        let unsub1, unsub2, unsub3;
        if (authReady) {
            unsub1 = loadBooks();
            unsub2 = loadUsers();
            unsub3 = loadTransactions();
        }
        return () => {
            unsub1 && unsub1();
            unsub2 && unsub2();
            unsub3 && unsub3();
        };
    }, [authReady, loadBooks, loadUsers, loadTransactions]);


    // --- RENDERING LOGIC ---

    if (!authReady) {
        return (
            <div className="flex items-center justify-center h-screen bg-gray-100">
                <div className="text-xl font-semibold text-gray-700 p-8 bg-white rounded-xl shadow-lg animate-pulse">
                    <Clock className="inline mr-2 animate-spin" size={24}/> Loading Library System...
                </div>
            </div>
        );
    }

    // Main content rendering based on 'view' state
    const renderContent = () => {
        switch (view) {
            case 'Dashboard':
                return <Dashboard books={books} users={users} transactions={transactions} />;
            case 'Books':
                return <BookManagement db={db} books={books} bookCollection={bookCollection} loadBooks={loadBooks} />;
            case 'Users':
                return <UserManagement db={db} users={users} userCollection={userCollection} loadUsers={loadUsers} />;
            case 'Transactions':
                return <TransactionManagement db={db} bookCollection={bookCollection} transactionCollection={transactionCollection} loadTransactions={loadTransactions} books={books} users={users} />;
            case 'Reports':
                return <Reports books={books} users={users} transactions={transactions} userCollection={userCollection} />;
            default:
                return <Dashboard books={books} users={users} transactions={transactions} />;
        }
    };

    const navItems = [
        { name: 'Dashboard', icon: Home, view: 'Dashboard' },
        { name: 'Books', icon: Book, view: 'Books' },
        { name: 'Users', icon: User, view: 'Users' },
        { name: 'Transactions', icon: ArrowLeftRight, view: 'Transactions' },
        { name: 'Reports', icon: BarChart, view: 'Reports' },
    ];

    return (
        <div className="min-h-screen bg-gray-50 flex font-sans">
            {/* Sidebar Navigation */}
            <aside className="w-64 bg-gray-800 text-white p-4 flex flex-col shadow-2xl">
                <div className="text-2xl font-extrabold mb-8 text-blue-300">LMS 📚</div>
                <nav className="flex-grow space-y-2">
                    {navItems.map((item) => (
                        <div
                            key={item.name}
                            onClick={() => setView(item.view)}
                            className={`flex items-center p-3 rounded-xl cursor-pointer transition-all duration-200 ${
                                view === item.view 
                                    ? 'bg-blue-600 font-bold shadow-lg' 
                                    : 'hover:bg-gray-700'
                            }`}
                        >
                            <item.icon size={20} className="mr-3" />
                            {item.name}
                        </div>
                    ))}
                </nav>
                 <div className="text-xs text-gray-400 mt-auto pt-4 border-t border-gray-700">
                    User ID: {userId ? userId.substring(0, 8) + '...' : 'Anon'}
                    <br/>
                    App ID: {appId.substring(0, 8) + '...'}
                </div>
            </aside>

            {/* Main Content Area */}
            <main className="flex-grow p-8 overflow-y-auto">
                {renderContent()}
            </main>
        </div>
    );
};

export default App;