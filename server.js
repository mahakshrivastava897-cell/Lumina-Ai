import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post("/api/chat", async (req, res) => {
  try {
    const { history } = req.body;

    const validHistory = (history || []).filter(
      (msg) =>
        msg.text !== "Sorry, something went wrong." &&
        msg.text !== "Hello! I am Lumina. How can I assist you today?"
    );

    const contents = validHistory.map((msg) => ({
      role: msg.sender === "user" ? "user" : "model",
      parts: [{ text: msg.text }],
    }));

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: contents,
      config: {
        systemInstruction: "You are Lumina, an intelligent, sleek, and helpful AI assistant.",
      },
    });

    res.json({ text: response.text });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lumina AI server running at http://localhost:${PORT}`);
});