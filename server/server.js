const express = require("express");
const { pool } = require("./database");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const User = require("./models/User");
const bcrypt = require("bcrypt");
const { initializeDatabase } = require("./dbinit");
const { authenticateToken } = require("./middleware/auth");
const path = require("path");
require("dotenv").config();

const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);

// Определяем базовый URL в зависимости от окружения
const getBaseUrl = () => {
  if (process.env.NODE_ENV === "production") {
    return `https://${
      process.env.HEROKU_APP_NAME || "devchat-627b61eb11e2"
    }.herokuapp.com`;
  }
  return "http://localhost:5173";
};

const io = socketIo(server, {
  cors: {
    origin:
      process.env.NODE_ENV === "production"
        ? [getBaseUrl(), "https://devchat-627b61eb11e2.herokuapp.com"]
        : ["http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(express.json());

// CORS configuration
const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? [getBaseUrl(), "https://devchat-627b61eb11e2.herokuapp.com"]
      : ["http://localhost:5173", "http://localhost:3000"],
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// Serve static files from React build
if (process.env.NODE_ENV === "production") {
  const frontendPath = path.join(__dirname, "../frontend/dist");
  console.log("Serving static files from:", frontendPath);
  app.use(express.static(frontendPath));
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
  });
});

// AUTH ROUTES
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ message: "Username and password are required" });
    }

    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const user = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const token = jwt.sign(
      { user_id: user.user_id, username },
      process.env.SECRET_KEY,
      { expiresIn: "24h" }
    );

    res.status(200).json({
      message: "Login successful",
      user: {
        id: user.user_id,
        username: user.username,
      },
      token,
    });
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ message: "Username and password are required" });
    }

    const userCheck = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );

    if (userCheck.rows.length > 0) {
      return res.status(409).json({ error: "User already exists" });
    }

    const newUser = await User.create(username, password);

    const token = jwt.sign(
      { user_id: newUser.user_id, username },
      process.env.SECRET_KEY,
      { expiresIn: "1h" }
    );

    res.status(201).json({
      message: "User created successfully",
      user: {
        id: newUser.user_id,
        username: newUser.username,
      },
      token,
    });
  } catch (error) {
    console.error("Error registering user:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// USER ROUTES
app.get("/api/users", authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.user.user_id;

    const result = await pool.query(
      "SELECT user_id, username FROM users WHERE user_id != $1 ORDER BY username",
      [currentUserId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// CHAT ROUTES
app.get("/api/chats", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const result = await pool.query(
      `SELECT c.chat_id, c.name, c.is_group
            FROM chats c
            JOIN chat_members cm ON c.chat_id = cm.chat_id
            WHERE cm.user_id = $1`,
      [userId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error fetching chats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/chats/by-usernames", authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { name, usernames = [], is_group } = req.body;
    const creatorId = req.user.user_id;

    if (!name) {
      return res.status(400).json({ error: "Chat name is required" });
    }

    const userIds = [];
    for (const username of usernames) {
      const user = await User.findByUsername(username);
      if (user) {
        userIds.push(user.user_id);
      } else {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: `User '${username}' not found` });
      }
    }

    const allUserIds = [...new Set([creatorId, ...userIds])];

    const chatResult = await client.query(
      `INSERT INTO chats (name, is_group) VALUES ($1, $2) RETURNING *`,
      [name, is_group || userIds.length > 0]
    );

    const chatId = chatResult.rows[0].chat_id;

    for (const userId of allUserIds) {
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)`,
        [chatId, userId]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      ...chatResult.rows[0],
      members_added: allUserIds.length,
      message: "Chat created successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating chat by usernames:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

app.post("/api/chats/with-user", authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { username } = req.body;
    const creatorId = req.user.user_id;

    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    const targetUser = await User.findByUsername(username);
    if (!targetUser) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: `User '${username}' not found` });
    }

    if (targetUser.user_id === creatorId) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "Cannot create chat with yourself" });
    }

    const existingChat = await client.query(
      `
      SELECT c.chat_id, c.name, c.is_group
      FROM chats c
      JOIN chat_members cm1 ON c.chat_id = cm1.chat_id
      JOIN chat_members cm2 ON c.chat_id = cm2.chat_id
      WHERE c.is_group = false
        AND cm1.user_id = $1
        AND cm2.user_id = $2
      LIMIT 1
    `,
      [creatorId, targetUser.user_id]
    );

    if (existingChat.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(200).json({
        ...existingChat.rows[0],
        message: "Chat already exists",
        existing: true,
      });
    }

    const chatName = `Chat with ${username}`;
    const chatResult = await client.query(
      `INSERT INTO chats (name, is_group) VALUES ($1, false) RETURNING *`,
      [chatName]
    );

    const chatId = chatResult.rows[0].chat_id;

    await client.query(
      `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [chatId, creatorId, targetUser.user_id]
    );

    await client.query("COMMIT");

    console.log(
      `Created private chat between users ${creatorId} and ${targetUser.user_id}`
    );

    res.status(201).json({
      ...chatResult.rows[0],
      message: "Private chat created successfully",
      existing: false,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating private chat:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// MESSAGE ROUTES
app.get("/api/chat-messages/:chatId", authenticateToken, async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const userId = req.user.user_id;

    if (!chatId || isNaN(chatId)) {
      return res.status(400).json({ error: "Invalid chat ID" });
    }

    const memberCheck = await pool.query(
      `SELECT * FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [chatId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ error: "User is not a member of this chat" });
    }

    const messages = await pool.query(
      `SELECT m.*, u.username as sender_name
             FROM messages m
             JOIN users u ON m.sender_id = u.user_id
             WHERE m.chat_id = $1
             ORDER BY m.sent_at ASC
            `,
      [chatId]
    );

    res.status(200).json(messages.rows);
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/chat-messages/:chatId", authenticateToken, async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const { text } = req.body;
    const userId = req.user.user_id;

    if (!chatId || isNaN(chatId)) {
      return res.status(400).json({ error: "Invalid chat ID" });
    }

    const memberCheck = await pool.query(
      `SELECT * FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [chatId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ error: "User is not a member of this chat" });
    }

    const result = await pool.query(
      `INSERT INTO messages (chat_id, sender_id, text)
             VALUES ($1, $2, $3)
             RETURNING *`,
      [chatId, userId, text]
    );

    const userResult = await pool.query(
      `SELECT username FROM users WHERE user_id = $1`,
      [userId]
    );

    const message = {
      ...result.rows[0],
      sender_name: userResult.rows[0].username,
    };

    res.status(201).json(message);
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE CHAT
app.delete("/api/chats/:chatId", authenticateToken, async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const userId = req.user.user_id;

    if (!chatId || isNaN(chatId)) {
      return res.status(400).json({ error: "Invalid chat ID" });
    }

    const memberCheck = await pool.query(
      `SELECT * FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [chatId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ error: "User is not a member of this chat" });
    }

    await pool.query(`DELETE FROM chats WHERE chat_id = $1`, [chatId]);

    res.status(200).json({ message: "Chat deleted" });
  } catch (error) {
    console.error("Error deleting chat:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/status", (req, res) => {
  res.status(200).json({ message: "Server is running" });
});

// Serve React app for all other routes in production
if (process.env.NODE_ENV === "production") {
  app.get("*", (req, res) => {
    const indexPath = path.join(__dirname, "../frontend/dist/index.html");
    console.log("Serving index.html from:", indexPath);
    res.sendFile(indexPath);
  });
}

// Socket.IO
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("join_chat", (chatId) => {
    socket.join(chatId.toString());
    console.log(`Client ${socket.id} joined chat room ${chatId}`);
  });

  socket.on("leave_chat", (chatId) => {
    socket.leave(chatId.toString());
    console.log(`Client ${socket.id} left chat room ${chatId}`);
  });

  socket.on("send_message", async (data) => {
    try {
      const { chatId, text, userId, username } = data;

      console.log(
        `Attempting to send message to chat ${chatId} from user ${username}`
      );

      const memberCheck = await pool.query(
        "SELECT * FROM chat_members WHERE chat_id = $1 AND user_id = $2",
        [chatId, userId]
      );

      if (memberCheck.rowCount === 0) {
        console.log(`User ${userId} is not a member of chat ${chatId}`);
        socket.emit("error", "You are not a member of this chat");
        return;
      }

      const result = await pool.query(
        "INSERT INTO messages (chat_id, sender_id, text) VALUES ($1, $2, $3) RETURNING *",
        [chatId, userId, text]
      );

      const message = {
        ...result.rows[0],
        sender_name: username,
      };

      io.to(chatId.toString()).emit("receive_message", message);

      console.log(
        `Message sent to chat room ${chatId}: "${text}" by ${username}`
      );
    } catch (error) {
      console.error("Error sending message:", error);
      socket.emit("error", "Failed to send message");
    }
  });

  socket.on("typing", (data) => {
    console.log(`${data.username} is typing in chat ${data.chatId}`);
    socket.to(data.chatId.toString()).emit("user_typing", {
      username: data.username,
      chatId: data.chatId,
    });
  });

  socket.on("stop_typing", (data) => {
    console.log(`${data.username} stopped typing in chat ${data.chatId}`);
    socket.to(data.chatId.toString()).emit("user_stop_typing", {
      username: data.username,
      chatId: data.chatId,
    });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

async function startServer() {
  try {
    console.log("Starting server...");
    console.log("NODE_ENV:", process.env.NODE_ENV);
    console.log("PORT:", process.env.PORT || 3000);

    if (!process.env.SECRET_KEY) {
      throw new Error("SECRET_KEY environment variable is required");
    }

    await initializeDatabase();
    console.log("Database initialized successfully");

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();