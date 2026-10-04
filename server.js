/**
 * Swarajya Platform - Express Backend Server
 * Powered by Native SQL Database (SQLite) & RESTful API Architecture
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database/db');

const app = express();
const PORT = process.env.PORT || 8080;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static file serving from workspace root and public folder
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// Auto-migrate schema changes if needed
try {
    db.exec("ALTER TABLE users ADD COLUMN gender VARCHAR(20) DEFAULT 'male'");
} catch (e) {
    // column already exists
}

// -------------------------------------------------------------
// 1. HEALTH & TELEMETRY API
// -------------------------------------------------------------
app.get('/api/status', (req, res) => {
    try {
        const usersCount = db.get('SELECT COUNT(*) as c FROM users').c;
        const donorsCount = db.get('SELECT COUNT(*) as c FROM blood_donors').c;
        const sosCount = db.get("SELECT COUNT(*) as c FROM sos_alerts WHERE status = 'active'").c;
        res.json({
            status: 'online',
            platform: 'Swarajya Community Welfare Platform',
            database: 'SQLite (Native node:sqlite)',
            stats: { usersCount, donorsCount, activeSosCount: sosCount }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 2. AUTHENTICATION API (Strictly 2 Roles: 'user' / 'admin')
// -------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
    try {
        const { fullName, email, phone, address, bloodGroup, password, emergencyContact, gender } = req.body;
        if (!fullName || !email || !phone || !password) {
            return res.status(400).json({ error: 'Required fields missing' });
        }

        const existing = db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR phone = ?', [email, phone]);
        if (existing) {
            return res.status(409).json({ error: 'Email or Mobile number is already registered!' });
        }

        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        const uiId = `SWAR-2026-${randomSuffix}`;
        const blood = bloodGroup || 'O+';
        const emergency = emergencyContact || '112 / Nearby Police';
        const userGender = gender || 'male';
        const roleTitle = userGender === 'female' ? ' (मावळीण)' : ' (मावळा)';

        db.run(
            `INSERT INTO users (ui_id, full_name, email, phone, address, role, password, blood_group, emergency_contact, gender, registered_at)
             VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, CURRENT_DATE)`,
            [uiId, fullName, email, phone, address || 'Pune', password, blood, emergency, userGender]
        );

        // Auto-add new user to blood donors list
        const donorExists = db.get('SELECT id FROM blood_donors WHERE phone = ?', [phone]);
        if (!donorExists) {
            db.run(
                `INSERT INTO blood_donors (name, blood_group, area, phone, last_donated, verified, user_ui_id)
                 VALUES (?, ?, ?, ?, 'Available Now', 1, ?)`,
                [`${fullName}${roleTitle}`, blood, address || 'Pune', phone, uiId]
            );
        }

        const newUser = db.get('SELECT * FROM users WHERE ui_id = ?', [uiId]);
        res.status(201).json({ success: true, user: mapUser(newUser) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', (req, res) => {
    try {
        const { identifier, password } = req.body;
        if (!identifier || !password) {
            return res.status(400).json({ error: 'Identifier and password are required' });
        }

        const user = db.get(
            `SELECT * FROM users WHERE (LOWER(email) = LOWER(?) OR phone = ?) AND password = ?`,
            [identifier, identifier, password]
        );

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials. Check email/phone and password.' });
        }

        res.json({ success: true, user: mapUser(user) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Firebase Auth Synchronization Endpoint
app.post('/api/auth/firebase-sync', (req, res) => {
    try {
        const { uid, email, displayName, photoURL } = req.body;
        if (!uid || !email) {
            return res.status(400).json({ error: 'Firebase UID and email required' });
        }

        let user = db.get('SELECT * FROM users WHERE firebase_uid = ? OR LOWER(email) = LOWER(?)', [uid, email]);

        if (user) {
            // Update firebase_uid and avatar if provided
            db.run("UPDATE users SET firebase_uid = ?, avatar = COALESCE(NULLIF(avatar, ''), ?) WHERE id = ?", [uid, photoURL || '', user.id]);
            user = db.get('SELECT * FROM users WHERE id = ?', [user.id]);
        } else {
            // Create user from Firebase
            const randomSuffix = Math.floor(1000 + Math.random() * 9000);
            const uiId = `SWAR-2026-${randomSuffix}`;
            const name = displayName || email.split('@')[0];
            const defaultPhone = '98' + Math.floor(10000000 + Math.random() * 90000000);

            db.run(
                `INSERT INTO users (ui_id, full_name, email, phone, address, role, password, blood_group, emergency_contact, avatar, firebase_uid, registered_at)
                 VALUES (?, ?, ?, ?, 'Pune, Maharashtra', 'user', 'firebase_oauth', 'O+', '112', ?, ?, CURRENT_DATE)`,
                [uiId, name, email, defaultPhone, photoURL || '', uid]
            );

            // Auto-add to blood donors
            db.run(
                `INSERT INTO blood_donors (name, blood_group, area, phone, last_donated, verified, user_ui_id)
                 VALUES (?, 'O+', 'Pune, Maharashtra', ?, 'Available Now', 1, ?)`,
                [`${name} (मावळा)`, defaultPhone, uiId]
            );

            user = db.get('SELECT * FROM users WHERE ui_id = ?', [uiId]);
        }

        res.json({ success: true, user: mapUser(user) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 3. USERS & PROFILE MANAGEMENT (Real-time Admin sync)
// -------------------------------------------------------------
app.get('/api/users', (req, res) => {
    try {
        const rows = db.all('SELECT * FROM users ORDER BY id ASC');
        res.json(rows.map(mapUser));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:ui_id', (req, res) => {
    try {
        const { ui_id } = req.params;
        const { fullName, phone, email, bloodGroup, address, emergencyContact, avatar, gender } = req.body;

        const current = db.get('SELECT * FROM users WHERE ui_id = ?', [ui_id]);
        if (!current) {
            return res.status(404).json({ error: 'User not found' });
        }

        const oldPhone = current.phone;

        db.run(
            `UPDATE users SET 
                full_name = COALESCE(?, full_name),
                phone = COALESCE(?, phone),
                email = COALESCE(?, email),
                blood_group = COALESCE(?, blood_group),
                address = COALESCE(?, address),
                emergency_contact = COALESCE(?, emergency_contact),
                avatar = COALESCE(?, avatar),
                gender = COALESCE(?, gender)
             WHERE ui_id = ?`,
            [fullName ?? null, phone ?? null, email ?? null, bloodGroup ?? null, address ?? null, emergencyContact ?? null, avatar ?? null, gender ?? null, ui_id]
        );

        // Synchronize in blood donors table as well
        const updated = db.get('SELECT * FROM users WHERE ui_id = ?', [ui_id]);
        const donorRoleSuffix = updated.role === 'admin' ? ' (Admin)' : (updated.gender === 'female' ? ' (मावळीण)' : ' (मावळा)');
        const newDonorName = updated.full_name + donorRoleSuffix;

        const matchedDonor = db.get('SELECT id FROM blood_donors WHERE user_ui_id = ? OR phone = ?', [ui_id, oldPhone]);
        if (matchedDonor) {
            db.run(
                `UPDATE blood_donors SET name = ?, phone = ?, blood_group = ?, area = ?, user_ui_id = ? WHERE id = ?`,
                [newDonorName, updated.phone, updated.blood_group, updated.address, ui_id, matchedDonor.id]
            );
        } else {
            db.run(
                `INSERT INTO blood_donors (name, blood_group, area, phone, last_donated, verified, user_ui_id)
                 VALUES (?, ?, ?, ?, 'Available Now', 1, ?)`,
                [newDonorName, updated.blood_group, updated.address, updated.phone, ui_id]
            );
        }

        res.json({ success: true, user: mapUser(updated) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 4. BLOOD DONORS API
// -------------------------------------------------------------
app.get('/api/donors', (req, res) => {
    try {
        const rows = db.all('SELECT * FROM blood_donors ORDER BY id DESC');
        res.json(rows.map(d => ({
            id: d.id,
            name: d.name,
            bloodGroup: d.blood_group,
            area: d.area,
            phone: d.phone,
            lastDonated: d.last_donated,
            verified: Boolean(d.verified),
            userUiId: d.user_ui_id
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/donors', (req, res) => {
    try {
        const { name, bloodGroup, area, phone } = req.body;
        if (!name || !bloodGroup || !phone) {
            return res.status(400).json({ error: 'Name, blood group, and phone required' });
        }

        db.run(
            `INSERT INTO blood_donors (name, blood_group, area, phone, last_donated, verified)
             VALUES (?, ?, ?, ?, 'Available Now', 1)`,
            [name, bloodGroup, area || 'Pune', phone]
        );
        res.status(201).json({ success: true, message: 'Donor registered successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 5. EMERGENCY SOS ALERTS API
// -------------------------------------------------------------
app.get('/api/sos', (req, res) => {
    try {
        const rows = db.all('SELECT * FROM sos_alerts ORDER BY created_at DESC');
        res.json(rows.map(r => ({
            id: r.id,
            name: r.name,
            phone: r.phone,
            location: r.location,
            lat: r.lat,
            lng: r.lng,
            time: r.time,
            status: r.status
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sos', (req, res) => {
    try {
        const { id, name, phone, location, lat, lng, time } = req.body;
        const alertId = id || 'sos_' + Date.now();
        db.run(
            `INSERT INTO sos_alerts (id, name, phone, location, lat, lng, time, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
            [alertId, name, phone, location, lat || 18.5204, lng || 73.8567, time || new Date().toLocaleTimeString()]
        );
        res.status(201).json({ success: true, id: alertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sos/:id', (req, res) => {
    try {
        const { id } = req.params;
        db.run('DELETE FROM sos_alerts WHERE id = ?', [id]);
        res.json({ success: true, message: 'SOS alert resolved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 6. MEDICAL CROWDFUNDING API
// -------------------------------------------------------------
app.get('/api/medical', (req, res) => {
    try {
        const rows = db.all('SELECT * FROM medical_requests ORDER BY created_at DESC');
        res.json(rows.map(r => ({
            id: r.id,
            name: r.patient_name,
            title: r.title,
            amount: r.amount,
            raised: r.raised,
            desc: r.description,
            hospital: r.hospital,
            status: r.status,
            date: r.date,
            phone: r.phone,
            donorsCount: r.donors_count,
            billProofName: r.bill_proof_name
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/medical', (req, res) => {
    try {
        const { name, title, amount, hospital, desc, phone, billProofName } = req.body;
        const id = 'med_' + Date.now();
        const dateStr = new Date().toISOString().split('T')[0];

        db.run(
            `INSERT INTO medical_requests (id, patient_name, title, amount, raised, description, hospital, status, date, phone, donors_count, bill_proof_name)
             VALUES (?, ?, ?, ?, 0, ?, ?, 'pending', ?, ?, 0, ?)`,
            [id, name, title, Number(amount) || 50000, desc, hospital, dateStr, phone, billProofName || 'Estimate.pdf']
        );
        res.status(201).json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/medical/:id/status', (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        db.run('UPDATE medical_requests SET status = ? WHERE id = ?', [status, id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 7. FARMER INNOVATIONS API
// -------------------------------------------------------------
app.get('/api/agriculture', (req, res) => {
    try {
        const rows = db.all('SELECT * FROM agriculture_posts ORDER BY created_at DESC');
        res.json(rows.map(p => ({
            id: p.id,
            farmerName: p.farmer_name,
            village: p.village,
            title: p.title,
            category: p.category,
            costSavings: p.cost_savings,
            desc: p.description,
            status: p.status,
            upvotes: p.upvotes,
            date: p.date,
            hasImage: Boolean(p.has_image)
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/agriculture', (req, res) => {
    try {
        const { farmerName, village, title, category, costSavings, desc } = req.body;
        const id = 'agri_' + Date.now();
        const dateStr = new Date().toISOString().split('T')[0];

        db.run(
            `INSERT INTO agriculture_posts (id, farmer_name, village, title, category, cost_savings, description, status, upvotes, date, has_image)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0)`,
            [id, farmerName, village, title, category, costSavings, desc, dateStr]
        );
        res.status(201).json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/agriculture/:id/status', (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        db.run('UPDATE agriculture_posts SET status = ? WHERE id = ?', [status, id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/agriculture/:id/upvote', (req, res) => {
    try {
        const { id } = req.params;
        db.run('UPDATE agriculture_posts SET upvotes = upvotes + 1 WHERE id = ?', [id]);
        const post = db.get('SELECT upvotes FROM agriculture_posts WHERE id = ?', [id]);
        res.json({ success: true, upvotes: post ? post.upvotes : 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 8. AMBULANCES & CHAT API
// -------------------------------------------------------------
app.get('/api/ambulances', (req, res) => {
    try {
        const rows = db.all('SELECT * FROM ambulances');
        res.json(rows.map(a => ({
            id: a.id,
            name: a.name,
            area: a.area,
            phone: a.phone,
            mobile: a.mobile,
            driver: a.driver,
            type: a.type,
            available: Boolean(a.available),
            eta: a.eta
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chat', (req, res) => {
    try {
        const rows = db.all('SELECT * FROM chat_messages ORDER BY id ASC');
        res.json(rows.map(m => ({
            sender: m.sender,
            role: m.role,
            text: m.text,
            time: m.time,
            tag: m.tag
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat', (req, res) => {
    try {
        const { sender, role, text, tag } = req.body;
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        db.run(
            `INSERT INTO chat_messages (sender, role, text, time, tag)
             VALUES (?, ?, ?, ?, ?)`,
            [sender, role, text, timeStr, tag || 'Community']
        );
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ambulances', (req, res) => {
    try {
        const { name, area, phone, mobile, driver, type, eta } = req.body;
        if (!name || !phone) {
            return res.status(400).json({ error: 'Ambulance name and phone required' });
        }
        const id = 'amb_' + Date.now();
        db.run(
            `INSERT INTO ambulances (id, name, area, phone, mobile, driver, type, available, eta)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [id, name, area || 'Pune', phone, mobile || phone, driver || 'Emergency Driver', type || 'Basic Life Support (BLS)', eta || '10-15 mins']
        );
        res.status(201).json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// 9. REPORTED ISSUES & CITIZEN HELP DESK API
// -------------------------------------------------------------
app.get('/api/issues', (req, res) => {
    try {
        const rows = db.all('SELECT * FROM reported_issues ORDER BY created_at DESC');
        res.json(rows.map(i => ({
            id: i.id,
            title: i.title,
            category: i.category,
            description: i.description,
            reportedByName: i.reported_by_name,
            reportedByPhone: i.reported_by_phone,
            reportedUserTarget: i.reported_user_target,
            status: i.status,
            adminNotes: i.admin_notes || '',
            createdAt: i.created_at
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/issues', (req, res) => {
    try {
        const { title, category, description, reportedByName, reportedByPhone, reportedUserTarget } = req.body;
        if (!title || !description || !reportedByName) {
            return res.status(400).json({ error: 'Title, description, and name are required' });
        }
        const id = 'iss_' + Date.now();
        db.run(
            `INSERT INTO reported_issues (id, title, category, description, reported_by_name, reported_by_phone, reported_user_target, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [id, title, category || 'grievance', description, reportedByName, reportedByPhone || '', reportedUserTarget || '']
        );
        res.status(201).json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/issues/:id/status', (req, res) => {
    try {
        const { id } = req.params;
        const { status, adminNotes } = req.body;
        db.run(
            `UPDATE reported_issues SET status = ?, admin_notes = COALESCE(?, admin_notes) WHERE id = ?`,
            [status, adminNotes || null, id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper: Map DB row to user model
function mapUser(u) {
    return {
        uiId: u.ui_id,
        fullName: u.full_name,
        email: u.email,
        phone: u.phone,
        address: u.address,
        role: u.role, // strictly 'user' or 'admin'
        password: u.password,
        bloodGroup: u.blood_group,
        emergencyContact: u.emergency_contact,
        avatar: u.avatar || '',
        gender: u.gender || 'male',
        firebaseUid: u.firebase_uid || '',
        registeredAt: u.registered_at
    };
}

// Dedicated HTML page endpoints for topic-wise navigation
app.get('/safety', (req, res) => res.sendFile(path.join(__dirname, 'safety.html')));
app.get('/health', (req, res) => res.sendFile(path.join(__dirname, 'health.html')));
app.get('/agriculture', (req, res) => res.sendFile(path.join(__dirname, 'agriculture.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/standalone', (req, res) => res.sendFile(path.join(__dirname, 'swarajya_community_welfare_platform.html')));

// Fallback for single-page routing
app.use((req, res) => {
    if (req.url.startsWith('/api')) {
        return res.status(404).json({ error: 'Endpoint not found' });
    }
    const targetHtml = path.join(__dirname, 'index.html');
    res.sendFile(targetHtml);
});

// Start Server
app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚩 SWARAJYA WELFARE PLATFORM BACKEND STARTED 🚩`);
    console.log(`📡 Server running on http://localhost:${PORT}`);
    console.log(`🗄️ SQL Database: SQLite initialized & synced`);
    console.log(`🔥 Firebase Auth Support: Active & Configurable`);
    console.log(`=======================================================`);
});
