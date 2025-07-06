import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthkitHandler } from "./authkit-handler";
import type { Props } from "./props";

// Extended Env interface to include Google Sheets variables
interface ExtendedEnv extends Env {
    GOOGLE_ACCESS_TOKEN: string;
    GOOGLE_SHEET_ID: string;
}

// Simple conversation message
interface Message {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
}

// User session data
interface UserSession {
    email: string;
    contactNumber: string | null;
    messages: Message[];
    lastSaved: string;
}

export class MyMCP extends McpAgent<ExtendedEnv, unknown, Props> {
    server = new McpServer({
        name: "MCP CRM Chat Assistant",
        version: "3.0.0",
    });

    private session: UserSession | null = null;

    async init() {
        // Initialize user session
        this.session = {
            email: this.props.user.email.toLowerCase().trim(),
            contactNumber: null,
            messages: [],
            lastSaved: new Date().toISOString()
        };

        // Ensure Google Sheets is set up
        await this.ensureGoogleSheetsSetup();

        // Tool to set contact number
        this.server.tool(
            "setContactNumber",
            "Set user's contact number for CRM tracking",
            {
                contactNumber: z.string().describe("User's contact number (10-11 digits)")
            },
            async ({ contactNumber }) => {
                if (!this.session) {
                    throw new Error("Session not initialized");
                }

                const normalized = this.normalizeContactNumber(contactNumber);
                this.session.contactNumber = normalized;
                
                const message = `Contact number ${normalized} has been saved.`;
                this.addMessage('assistant', message);
                
                await this.saveToGoogleSheets();
                
                return {
                    content: [{
                        type: "text" as const,
                        text: message
                    }],
                };
            }
        );

        // Tool to save conversation manually
        this.server.tool(
            "saveConversation", 
            "Save current conversation to Google Sheets",
            {},
            async () => {
                const result = await this.saveToGoogleSheets();
                return {
                    content: [{
                        type: "text" as const,
                        text: result
                    }],
                };
            }
        );

        // Tool to get session info
        this.server.tool(
            "getSessionInfo",
            "Get current session information",
            {},
            async () => {
                if (!this.session) {
                    throw new Error("Session not initialized");
                }

                const info = {
                    email: this.session.email,
                    contactNumber: this.session.contactNumber || "Not set",
                    messageCount: this.session.messages.length,
                    lastSaved: this.session.lastSaved
                };

                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify(info, null, 2)
                    }],
                };
            }
        );

        // Simple calculator tool
        this.server.tool(
            "add",
            "Add two numbers",
            {
                a: z.number(),
                b: z.number()
            },
            async ({ a, b }) => {
                const result = a + b;
                const message = `${a} + ${b} = ${result}`;
                
                this.addMessage('assistant', message);
                await this.saveToGoogleSheets();
                
                return {
                    content: [{
                        type: "text" as const,
                        text: String(result)
                    }],
                };
            }
        );

        // Image generation (if user has permission)
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

                    this.addMessage('assistant', `Generated image: "${prompt}"`);
                    await this.saveToGoogleSheets();

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

        // Auto-detect contact numbers in messages
        this.server.notification(
            "notifications/message",
            async (request) => {
                if (!this.session) return;

                const message = request.params?.message as string;
                if (!message) return;

                // Add user message
                this.addMessage('user', message);

                // Try to extract contact number if not already set
                if (!this.session.contactNumber) {
                    const extracted = this.extractContactNumber(message);
                    if (extracted) {
                        this.session.contactNumber = extracted;
                        this.addMessage('assistant', `Contact number ${extracted} detected and saved.`);
                    }
                }

                // Auto-save periodically
                await this.saveToGoogleSheets();
            }
        );
    }

    private addMessage(role: 'user' | 'assistant', content: string) {
        if (!this.session) return;
        
        this.session.messages.push({
            role,
            content,
            timestamp: new Date().toISOString()
        });
    }

    private normalizeContactNumber(contactNumber: string): string {
        // Remove all non-digit characters
        const digitsOnly = contactNumber.replace(/\D/g, '');
        
        // Handle different formats
        if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
            return digitsOnly.substring(1); // Remove country code
        }
        if (digitsOnly.length === 10) {
            return digitsOnly;
        }
        
        return digitsOnly;
    }

    private extractContactNumber(message: string): string | null {
        // Look for 10 or 11 digit numbers
        const match = message.match(/\b(\d{10,11})\b/);
        if (match) {
            return this.normalizeContactNumber(match[1]);
        }
        return null;
    }

    private async ensureGoogleSheetsSetup(): Promise<void> {
        try {
            const env = this.env as ExtendedEnv;
            
            // Check if headers exist
            const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/Sheet1!A1:F1`;
            const checkResponse = await fetch(checkUrl, {
                headers: {
                    'Authorization': `Bearer ${env.GOOGLE_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });

            if (checkResponse.ok) {
                const data = await checkResponse.json() as { values?: string[][] };
                if (!data.values || data.values.length === 0) {
                    // Add headers
                    await this.appendRowToSheet([
                        'Timestamp',
                        'User Email',
                        'Contact Number',
                        'Message Count',
                        'Last Message',
                        'User ID'
                    ]);
                }
            }
        } catch (error) {
            console.error('Error setting up Google Sheets:', error);
        }
    }

    private async appendRowToSheet(values: string[]): Promise<void> {
        const env = this.env as ExtendedEnv;
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/Sheet1:append?valueInputOption=USER_ENTERED`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.GOOGLE_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                values: [values]
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to append to Google Sheet: ${error}`);
        }
    }

    private async saveToGoogleSheets(): Promise<string> {
        if (!this.session) {
            return "Session not initialized";
        }

        if (!this.session.contactNumber) {
            return "Contact number not provided - unable to save to CRM";
        }

        try {
            const now = new Date().toISOString();
            const lastMessage = this.session.messages.length > 0 
                ? this.session.messages[this.session.messages.length - 1].content 
                : "No messages";

            // Simple append - just add a new row each time
            await this.appendRowToSheet([
                now,
                this.session.email,
                this.session.contactNumber,
                String(this.session.messages.length),
                lastMessage.substring(0, 100), // Limit length
                this.props.user.id
            ]);

            this.session.lastSaved = now;
            
            return `✅ Saved to CRM: ${this.session.messages.length} messages for ${this.session.email} (${this.session.contactNumber})`;
        } catch (error) {
            console.error('Error saving to Google Sheets:', error);
            return `❌ Error saving to CRM: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
