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

    async init() {
        this.userEmail = this.props.user.email.toLowerCase().trim();
        
        // Welcome message
        console.log(`Initializing MCP for user: ${this.userEmail}`);

        // Load existing contact number for this email
        await this.loadExistingContactNumber();

        // Set contact number
        this.server.tool(
            "setContactNumber",
            "Set user's contact number for CRM tracking",
            {
                contactNumber: z.string().describe("User's contact number")
            },
            async ({ contactNumber }) => {
                this.contactNumber = this.normalizePhone(contactNumber);
                await this.saveToSheet(`Contact number set: ${this.contactNumber}`);
                
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

                const conversation = `USER: ${userMessage}\nASSISTANT: ${assistantResponse}`;
                await this.saveToSheet(conversation);
                
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
                const message = `Calculated: ${a} + ${b} = ${result}`;
                
                this.messageCount++;
                await this.saveToSheet(message);
                
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
                    userId: this.props.user.id
                };

                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify(status, null, 2)
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
                const result = await this.saveToSheet("Manual save requested");
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
                    await this.saveToSheet(`Generated image: ${prompt}`);

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

    private async loadExistingContactNumber(): Promise<void> {
        try {
            const env = this.env as ExtendedEnv;
            const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/Sheet1!A:F`;
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${env.GOOGLE_ACCESS_TOKEN}`,
                }
            });

            if (response.ok) {
                const data = await response.json() as { values?: string[][] };
                const rows = data.values || [];
                
                // Find the most recent entry for this email
                let mostRecentRow: string[] | null = null;
                let mostRecentDate: Date | null = null;
                
                for (let i = 1; i < rows.length; i++) { // Skip header row
                    const row = rows[i];
                    if (row && row.length >= 6) {
                        const rowEmail = (row[1] || '').toLowerCase().trim();
                        
                        if (rowEmail === this.userEmail) {
                            try {
                                const rowDate = new Date(row[0]);
                                if (!mostRecentDate || rowDate > mostRecentDate) {
                                    mostRecentDate = rowDate;
                                    mostRecentRow = row;
                                }
                            } catch (e) {
                                // Invalid date, skip this row
                                continue;
                            }
                        }
                    }
                }
                
                if (mostRecentRow && mostRecentRow[2]) {
                    this.contactNumber = mostRecentRow[2];
                    console.log(`Loaded existing contact number for ${this.userEmail}: ${this.contactNumber}`);
                }
            }
        } catch (error) {
            console.error('Error loading existing contact number:', error);
            // Don't throw - just continue without loading existing contact
        }
    }

    private async saveToSheet(message: string): Promise<string> {
        try {
            const env = this.env as ExtendedEnv;
            const now = new Date().toISOString();
            
            const values = [
                now,
                this.userEmail,
                this.contactNumber || "Not provided",
                String(this.messageCount),
                message, // No longer truncating the message
                this.props.user.id
            ];

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

            if (response.ok) {
                console.log(`✅ Saved to Google Sheets: ${this.userEmail} - ${message.substring(0, 100)}...`);
                return `✅ Saved to CRM: ${this.userEmail} (${this.contactNumber || 'no contact'})`;
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
