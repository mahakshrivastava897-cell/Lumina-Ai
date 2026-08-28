import { GoogleGenAI } from "@google/genai";
import readline from "readline";

// Replace with your actual key from https://aistudio.google.com/
const apiKey = process.env.GEMINI_API_KEY;
const chat = ai.chats.create({
  model: "gemini-2.0-flash",
  config: {
    systemInstruction: "You are a friendly, intelligent assistant. Keep answers brief and conversational.",
  },
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function promptUser() {
  rl.question("\nYou: ", async (userInput) => {
    if (userInput.toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
      return;
    }

    try {
      const response = await chat.sendMessage({ message: userInput });
      console.log(`\nBot: ${response.text}`);
    } catch (error) {
      console.error("Error generating response:", error.message);
    }

    promptUser();
  });
}

console.log("--- Interactive Chatbot Started (Type 'exit' to quit) ---");
promptUser();