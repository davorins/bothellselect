// index.js (or your main server file)
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Player = require('./models/Player');
const Parent = require('./models/Parent');
const PlayerRegistration = require('./models/PlayerRegistration');
const authRoutes = require('./routes/authRoutes');
const searchRoutes = require('./routes/searchRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const unpaidRoutes = require('./routes/unpaidRoutes');
const paymentProcessRoutes = require('./routes/paymentProcessRoutes');
const squareWebhooksRouter = require('./routes/squareWebhooks');
const { authenticate, isAdmin, isCoach, isUser } = require('./utils/auth');

const app = express();
const PORT = process.env.PORT || 5001;

// Enable CORS for specific domains
const allowedOrigins = [
  'http://localhost:3000',
  'https://bothellselect.com',
  'https://bothellselect.vercel.app',
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

// Middleware
app.use(express.json());

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });

// Use routes
app.use('/api', authRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/payments', unpaidRoutes);
app.use('/api/payments', paymentProcessRoutes);
app.use('/api/square', squareWebhooksRouter);

// Player Registration Routes

// Check if a player is already registered for a season and year
app.get(
  '/api/players/:playerId/registrations',
  authenticate,
  async (req, res) => {
    const { playerId } = req.params;
    const { season, year } = req.query;

    try {
      const registration = await PlayerRegistration.findOne({
        playerId,
        season,
        year,
      });

      if (registration) {
        return res.status(200).json({ isRegistered: true });
      } else {
        return res.status(200).json({ isRegistered: false });
      }
    } catch (error) {
      console.error('Error checking player registration:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Backend route for fetching player data
app.get('/api/player/:playerId', async (req, res) => {
  try {
    const playerId = req.params.playerId;
    const player = await Player.findById(playerId).select('+parentId');
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }
    res.json(player);
  } catch (error) {
    console.error('Error fetching player:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register a player for a season and year
app.post('/api/players/register', authenticate, async (req, res) => {
  const { playerId, season, year, grade, schoolName, gender } = req.body;

  try {
    // Check if the player is already registered for the season and year
    const existingRegistration = await PlayerRegistration.findOne({
      playerId,
      season,
      year,
    });

    if (existingRegistration) {
      return res
        .status(400)
        .json({ error: 'Player already registered for this season' });
    }

    // Create a new registration record
    const newRegistration = new PlayerRegistration({
      playerId,
      season,
      year,
      grade,
      schoolName,
      gender,
    });

    await newRegistration.save();

    return res.status(201).json({ message: 'Player registered successfully' });
  } catch (error) {
    console.error('Error registering player:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Protected routes
app.get('/api/admin-dashboard', authenticate, isAdmin, (req, res) => {
  res.json({ message: 'Welcome to the Admin Dashboard' });
});

app.get('/api/coach-dashboard', authenticate, isCoach, (req, res) => {
  res.json({ message: 'Welcome to the Coach Dashboard' });
});

app.get('/api/user-dashboard', authenticate, isUser, (req, res) => {
  res.json({ message: 'Welcome to the User Dashboard' });
});

// Fetch all registrations for a player
app.get(
  '/api/players/:playerId/all-registrations',
  authenticate,
  async (req, res) => {
    const { playerId } = req.params;
    try {
      const registrations = await PlayerRegistration.find({ playerId });
      res.status(200).json(registrations);
    } catch (error) {
      console.error('Error fetching registrations:', error);
      res.status(500).json({ error: 'Failed to fetch registrations' });
    }
  }
);

// Create or update player
app.post('/api/players', authenticate, async (req, res) => {
  try {
    const {
      fullName,
      gender,
      dob,
      schoolName,
      grade,
      healthConcerns,
      aauNumber,
      registrationYear,
      season,
      parentId,
    } = req.body;

    // Validate required fields
    if (!fullName || !gender || !dob || !parentId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const newPlayer = new Player({
      fullName,
      gender,
      dob,
      schoolName,
      grade,
      healthConcerns,
      aauNumber,
      registrationYear,
      season,
      parentId,
    });

    await newPlayer.save();

    // Update the parent's players array
    await Parent.findByIdAndUpdate(
      parentId,
      { $push: { players: newPlayer._id } },
      { new: true }
    );

    res.status(201).json(newPlayer);
  } catch (error) {
    console.error('Error creating player:', error);
    res.status(500).json({ error: 'Failed to create player' });
  }
});

// Update player details
app.put('/api/players/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Validate the ID
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid player ID format' });
    }

    const updatedPlayer = await Player.findByIdAndUpdate(id, updateData, {
      new: true, // Return the updated document
      runValidators: true, // Run schema validators on update
    });

    if (!updatedPlayer) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json(updatedPlayer);
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({
      error: 'Failed to update player',
      details: error.message,
    });
  }
});

// Check if the email is already registered
app.post('/api/check-email', async (req, res) => {
  const { email } = req.body;

  const user = await Parent.findOne({ email });

  if (user) {
    return res.status(409).json({ message: 'Email is already registered' });
  }
  res.status(200).json({ message: 'Email is available' });
});

app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Endpoint not found',
    requestedUrl: req.originalUrl,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Start the server
const startServer = (port) => {
  const server = app.listen(port, () =>
    console.log(`Server running on port ${port}`)
  );

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} is already in use. Trying a different port...`);
      startServer(port + 1); // Try the next port
    } else {
      console.error('Server error:', err);
    }
  });
};

startServer(PORT);
