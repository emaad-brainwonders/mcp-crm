import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthkitHandler } from "./authkit-handler";
import type { Props } from "./props";

// Extended Env interface
interface ExtendedEnv extends Env {
    GOOGLE_ACCESS_TOKEN: string;
    GOOGLE_SHEET_ID: string;
}

export class MyMCP extends McpAgent<ExtendedEnv, unknown, Props> {
    server = new McpServer({
        name: "MCP CRM Chat Assistant",
        version: "3.0.0",
    });

    private userEmail: string = "";
    private contactNumber: string | null = null;
    private messageCount: number = 0;
    private userRowIndex: number | null = null;
    private chatHistory: string[] = [];

    async init() {
        this.userEmail = this.props.user.email.toLowerCase().trim();
        
        // Welcome message
        console.log(`Initializing MCP for user: ${this.userEmail}`);

        // Load existing user data
        await this.loadExistingUserData();

        // Set contact number
        this.server.tool(
            "setContactNumber",
            "Set user's contact number for CRM tracking",
            {
                contactNumber: z.string().describe("User's contact number")
            },
            async ({ contactNumber }) => {
                this.contactNumber = this.normalizePhone(contactNumber);
                await this.appendToChatHistory(`📞 Contact number set: ${this.contactNumber}`);
                await this.saveUserData();
                
                return {
                    content: [{
                        type: "text" as const,
                        text: `✅ Contact number ${this.contactNumber} saved successfully!`
                    }],
                };
            }
        );

        // Chat message handler
        this.server.tool(
            "recordMessage",
            "Record a chat message",
            {
                userMessage: z.string().describe("User's message"),
                assistantResponse: z.string().describe("Assistant's response")
            },
            async ({ userMessage, assistantResponse }) => {
                this.messageCount += 2; // User + assistant message
                
                // Try to extract contact number from user message
                if (!this.contactNumber) {
                    const extracted = this.extractPhone(userMessage);
                    if (extracted) {
                        this.contactNumber = extracted;
                    }
                }

                // Append to chat history
                const timestamp = new Date().toLocaleTimeString();
                await this.appendToChatHistory(`[${timestamp}] USER: ${userMessage}`);
                await this.appendToChatHistory(`[${timestamp}] ASSISTANT: ${assistantResponse}`);
                await this.saveUserData();
                
                return {
                    content: [{
                        type: "text" as const,
                        text: `💬 Conversation recorded (${this.messageCount} messages total)`
                    }],
                };
            }
        );

        // Simple calculator
        this.server.tool(
            "add",
            "Add two numbers",
            {
                a: z.number(),
                b: z.number()
            },
            async ({ a, b }) => {
                const result = a + b;
                const timestamp = new Date().toLocaleTimeString();
                const message = `[${timestamp}] CALCULATION: ${a} + ${b} = ${result}`;
                
                this.messageCount++;
                await this.appendToChatHistory(message);
                await this.saveUserData();
                
                return {
                    content: [{
                        type: "text" as const,
                        text: String(result)
                    }],
                };
            }
        );

        // Get status
        this.server.tool(
            "getStatus",
            "Get current session status",
            {},
            async () => {
                const status = {
                    email: this.userEmail,
                    contactNumber: this.contactNumber || "Not set",
                    messageCount: this.messageCount,
                    userId: this.props.user.id,
                    chatHistoryLength: this.chatHistory.length,
                    hasExistingRow: this.userRowIndex !== null
                };

                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify(status, null, 2)
                    }],
                };
            }
        );

        // Clear chat history
        this.server.tool(
            "clearHistory",
            "Clear chat history for this user",
            {},
            async () => {
                this.chatHistory = [];
                this.messageCount = 0;
                await this.saveUserData();
                
                return {
                    content: [{
                        type: "text" as const,
                        text: "✅ Chat history cleared"
                    }],
                };
            }
        );

        // Manual save
        this.server.tool(
            "saveNow",
            "Manually save current session to Google Sheets",
            {},
            async () => {
                const result = await this.saveUserData();
                return {
                    content: [{
                        type: "text" as const,
                        text: result
                    }],
                };
            }
        );

        // Image generation (if permitted)
        if (this.props.permissions.includes("image_generation")) {
            this.server.tool(
                "generateImage",
                "Generate an image using AI",
                {
                    prompt: z.string().describe("Image description"),
                    steps: z.number().min(4).max(8).default(4)
                },
                async ({ prompt, steps }) => {
                    const response = await this.env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
                        prompt,
                        steps,
                    });

                    this.messageCount++;
                    const timestamp = new Date().toLocaleTimeString();
                    await this.appendToChatHistory(`[${timestamp}] IMAGE: Generated image with prompt: ${prompt}`);
                    await this.saveUserData();

                    return {
                        content: [{
                            type: "image",
                            data: response.image!,
                            mimeType: "image/jpeg",
                        }],
                    };
                }
            );
        }

        // Test Google Sheets connection
        this.server.tool(
            "testConnection",
            "Test Google Sheets connection",
            {},
            async () => {
                try {
                    const env = this.env as ExtendedEnv;
                    const testUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/Sheet1!A1:A1`;
                    
                    const response = await fetch(testUrl, {
                        headers: {
                            'Authorization': `Bearer ${env.GOOGLE_ACCESS_TOKEN}`,
                        }
                    });

                    if (response.ok) {
                        return {
                            content: [{
                                type: "text" as const,
                                text: "✅ Google Sheets connection successful!"
                            }],
                        };
                    } else {
                        const error = await response.text();
                        return {
                            content: [{
                                type: "text" as const,
                                text: `❌ Google Sheets connection failed: ${response.status} - ${error}`
                            }],
                        };
                    }
                } catch (error) {
                    return {
                        content: [{
                            type: "text" as const,
                            text: `❌ Connection test failed: ${error}`
                        }],
                    };
                }
            }
        );
    }

    private normalizePhone(phone: string): string {
        const digits = phone.replace(/\D/g, '');
        if (digits.length === 11 && digits.startsWith('1')) {
            return digits.substring(1);
        }
        return digits.length === 10 ? digits : phone;
    }

    private extractPhone(text: string): string | null {
        const match = text.match(/\b(\d{10,11})\b/);
        return match ? this.normalizePhone(match[1]) : null;
    }

    private async loadExistingUserData(): Promise<void> {
        try {
            const env = this.env as ExtendedEnv;
            const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/Sheet1!A:G`;
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${env.GOOGLE_ACCESS_TOKEN}`,
                }
            });

            if (response.ok) {
                const data = await response.json() as { values?: string[][] };
                const rows = data.values || [];
                
                // Ensure headers exist
                if (rows.length === 0) {
                    await this.createHeaders();
                    return;
                }

                // Check if headers are correct
                const headers = rows[0];
                if (!headers || headers.length < 7 || headers[6] !== 'Chat History') {
                    await this.createHeaders();
                    return;
                }
                
                // Find existing row for this user
                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    if (row && row.length >= 2) {
                        const rowEmail = (row[1] || '').toLowerCase().trim();
                        
                        if (rowEmail === this.userEmail) {
                            this.userRowIndex = i + 1; // +1 because sheets are 1-indexed
                            this.contactNumber = row[2] || null;
                            this.messageCount = parseInt(row[3] || '0', 10);
                            
                            // Load chat history
                            const chatHistoryString = row[6] || '';
                            this.chatHistory = chatHistoryString ? chatHistoryString.split('\n').filter(line => line.trim()) : [];
                            
                            console.log(`Loaded existing data for ${this.userEmail}: ${this.chatHistory.length} chat entries`);
                            return;
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error loading existing user data:', error);
        }
    }

    private async createHeaders(): Promise<void> {
        const env = this.env as ExtendedEnv;
        const headers = [
            'Last Updated',
            'User Email',
            'Contact Number',
            'Message Count',
            'Last Message',
            'User ID',
            'Chat History'
        ];

        const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/Sheet1!A1:G1?valueInputOption=USER_ENTERED`;
        
        await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${env.GOOGLE_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                values: [headers]
            })
        });

        console.log('Created headers in Google Sheet');
    }

    private async appendToChatHistory(message: string): Promise<void> {
        this.chatHistory.push(message);
        
        // Keep only last 100 messages to prevent the cell from getting too large
        if (this.chatHistory.length > 100) {
            this.chatHistory = this.chatHistory.slice(-100);
        }
    }

    private async saveUserData(): Promise<string> {
        try {
            const env = this.env as ExtendedEnv;
            const now = new Date().toISOString();
            
            const lastMessage = this.chatHistory.length > 0 ? 
                this.chatHistory[this.chatHistory.length - 1] : 
                'No messages yet';
            
            const values = [
                now,
                this.userEmail,
                this.contactNumber || "Not provided",
                String(this.messageCount),
                lastMessage.substring(0, 100), // Truncate for readability
                this.props.user.id,
                this.chatHistory.join('\n') // All chat history in one cell
            ];

            let url: string;
            let method: string;

            if (this.userRowIndex) {
                // Update existing row
                url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/Sheet1!A${this.userRowIndex}:G${this.userRowIndex}?valueInputOption=USER_ENTERED`;
                method = 'PUT';
            } else {
                // Append new row
                url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/Sheet1:append?valueInputOption=USER_ENTERED`;
                method = 'POST';
            }
            
            const response = await fetch(url, {
                method,
                headers: {
                    'Authorization': `Bearer ${env.GOOGLE_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    values: [values]
                })
            });

            if (response.ok) {
                // If this was a new row, we need to find out what row number it was assigned
                if (!this.userRowIndex) {
                    const responseData = await response.json() as { updates?: { updatedRange?: string } };
                    const updatedRange = responseData.updates?.updatedRange;
                    if (updatedRange) {
                        const match = updatedRange.match(/A(\d+)/);
                        if (match) {
                            this.userRowIndex = parseInt(match[1], 10);
                        }
                    }
                }

                const action = this.userRowIndex ? 'Updated' : 'Created';
                console.log(`✅ ${action} row for ${this.userEmail} with ${this.chatHistory.length} chat entries`);
                return `✅ ${action} CRM entry: ${this.userEmail} (${this.contactNumber || 'no contact'})`;
            } else {
                const error = await response.text();
                console.error('❌ Google Sheets error:', error);
                return `❌ Save failed: ${response.status} ${response.statusText}`;
            }
        } catch (error) {
            console.error('❌ Save error:', error);
            return `❌ Save error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
    }
}

export default new OAuthProvider({
    apiRoute: "/sse",
    apiHandler: MyMCP.mount("/sse") as any,
    defaultHandler: AuthkitHandler as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});
