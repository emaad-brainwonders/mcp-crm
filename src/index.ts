import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthkitHandler } from "./authkit-handler";
import type { Props } from "./props";
import { GoogleSheetsService } from "./google-sheets";

// Extended Env interface to include Google Sheets variables
interface ExtendedEnv extends Env {
    GOOGLE_ACCESS_TOKEN: string;
    GOOGLE_SHEET_ID: string;
}

// Simplified conversation storage
interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
}

export class MyMCP extends McpAgent<ExtendedEnv, unknown, Props> {
    server = new McpServer({
        name: "MCP CRM Chat Assistant",
        version: "2.0.0",
    });

    private conversation: ConversationMessage[] = [];
    private userContactNumber: string | null = null;
    private sessionStartTime: string = new Date().toISOString();
    private lastSaveTime: string = new Date().toISOString();
    private lastSavedMessageIndex: number = 0; // Track which messages have been saved

    async init() {
        // Initialize session
        await this.addMessage('assistant', 'Welcome! Please provide your contact number to get started.');
        await this.initializeGoogleSheets();

        // Main conversation handler - this captures ALL user interactions
        this.server.tool(
            "handleUserMessage",
            "Handle any user message and provide appropriate response",
            {
                userMessage: z.string().describe("The user's message"),
                assistantResponse: z.string().describe("The assistant's response"),
                saveToSheet: z.coerce.boolean().default(true).describe("Whether to save to Google Sheets")
            },
            async ({ userMessage, assistantResponse, saveToSheet }) => {
                // Add both messages to conversation
                await this.addMessage('user', userMessage);
                await this.addMessage('assistant', assistantResponse);

                // Check if this is a contact number
                if (this.isContactNumber(userMessage)) {
                    this.userContactNumber = this.extractContactNumber(userMessage);
                    console.log(`Contact number extracted: ${this.userContactNumber}`);
                }

                // Save to Google Sheets if requested
                if (saveToSheet) {
                    await this.saveConversationToSheet();
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: `Conversation recorded: ${this.conversation.length} messages total. Contact: ${this.userContactNumber || 'Not set'}`
                    }],
                };
            }
        );

        // Simple contact number setter
        this.server.tool(
            "setContactNumber",
            "Set the user's contact number",
            {
                contactNumber: z.string().describe("User's contact number")
            },
            async ({ contactNumber }) => {
                this.userContactNumber = this.normalizeContactNumber(contactNumber);
                await this.addMessage('assistant', `Contact number ${this.userContactNumber} saved successfully.`);
                await this.saveConversationToSheet();
                
                return {
                    content: [{
                        type: "text" as const,
                        text: `Contact number ${this.userContactNumber} has been saved.`
                    }],
                };
            }
        );

        // Batch conversation import
        this.server.tool(
            "importConversationHistory",
            "Import existing conversation history from a previous session",
            {
                messages: z.array(z.object({
                    role: z.enum(['user', 'assistant']),
                    content: z.string()
                })).describe("Array of conversation messages")
            },
            async ({ messages }) => {
                // Clear existing conversation
                this.conversation = [];
                this.lastSavedMessageIndex = 0;
                
                // Add all messages with timestamps
                for (const msg of messages) {
                    await this.addMessage(msg.role, msg.content);
                }

                // Extract contact number if present
                for (const msg of messages) {
                    if (msg.role === 'user' && this.isContactNumber(msg.content)) {
                        this.userContactNumber = this.extractContactNumber(msg.content);
                        console.log(`Contact number found in import: ${this.userContactNumber}`);
                        break;
                    }
                }

                // Save to Google Sheets
                await this.saveConversationToSheet();

                return {
                    content: [{
                        type: "text" as const,
                        text: `Imported ${messages.length} messages. Contact: ${this.userContactNumber || 'Not found'}`
                    }],
                };
            }
        );

        // Manual save tool
        this.server.tool(
            "saveConversation",
            "Manually save the current conversation to Google Sheets",
            {},
            async () => {
                const result = await this.saveConversationToSheet();
                return {
                    content: [{
                        type: "text" as const,
                        text: result
                    }],
                };
            }
        );

        // Enhanced session status
        this.server.tool(
            "getSessionStatus",
            "Get current session status and conversation info",
            {},
            async () => {
                const status = {
                    sessionStart: this.sessionStartTime,
                    totalMessages: this.conversation.length,
                    unsavedMessages: this.conversation.length - this.lastSavedMessageIndex,
                    contactNumber: this.userContactNumber || 'Not set',
                    normalizedContact: this.userContactNumber ? this.normalizeContactNumber(this.userContactNumber) : 'N/A',
                    userEmail: this.props.user.email,
                    normalizedEmail: this.normalizeEmail(this.props.user.email),
                    lastSaved: this.lastSaveTime
                };

                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify(status, null, 2)
                    }],
                };
            }
        );

        // Enhanced debug tool
        this.server.tool(
            "debugGoogleSheets",
            "Debug Google Sheets to see all rows and identify issues",
            {},
            async () => {
                try {
                    const env = this.env as ExtendedEnv;
                    const googleSheets = new GoogleSheetsService(env.GOOGLE_ACCESS_TOKEN, env.GOOGLE_SHEET_ID);
                    
                    // Debug all rows
                    await googleSheets.debugAllRows();
                    
                    // Get unique pairs
                    const pairs = await googleSheets.getUniqueEmailContactPairs();
                    console.log('Unique email-contact pairs in sheet:', pairs);
                    
                    // Test the find function
                    const email = this.normalizeEmail(this.props.user.email);
                    const contact = this.userContactNumber ? this.normalizeContactNumber(this.userContactNumber) : 'Not provided';
                    
                    console.log(`Testing find function for: "${email}" + "${contact}"`);
                    const result = await googleSheets.findRowByEmailAndContact(email, contact);
                    console.log('Find result:', result);
                    
                    return {
                        content: [{
                            type: "text" as const,
                            text: `Debug complete. Found ${pairs.length} unique pairs. Current user: ${email}, Contact: ${contact}. Check console for details.`
                        }],
                    };
                } catch (error) {
                    console.error('Debug error:', error);
                    return {
                        content: [{
                            type: "text" as const,
                            text: `Debug error: ${error instanceof Error ? error.message : 'Unknown error'}`
                        }],
                    };
                }
            }
        );

        // Enhanced test save function
        this.server.tool(
            "testSaveFunction",
            "Test the save function with specific parameters",
            {
                email: z.string().describe("Email to test with"),
                contactNumber: z.string().describe("Contact number to test with"),
                testMessage: z.string().describe("Test message to save")
            },
            async ({ email, contactNumber, testMessage }) => {
                try {
                    const env = this.env as ExtendedEnv;
                    const googleSheets = new GoogleSheetsService(env.GOOGLE_ACCESS_TOKEN, env.GOOGLE_SHEET_ID);
                    
                    const now = new Date().toISOString();
                    const testChatLines = [`[${now}] TEST: ${testMessage}`];
                    const otherValues = [now, `Test message: ${testMessage}`, this.props.user.id];
                    
                    // Normalize inputs before testing
                    const normalizedEmail = this.normalizeEmail(email);
                    const normalizedContact = this.normalizeContactNumber(contactNumber);
                    
                    console.log(`Testing save with normalized values: Email="${normalizedEmail}", Contact="${normalizedContact}"`);
                    
                    await googleSheets.appendChatLinesToRow(normalizedEmail, normalizedContact, testChatLines, otherValues);
                    
                    return {
                        content: [{
                            type: "text" as const,
                            text: `Test save completed for ${normalizedEmail} / ${normalizedContact}`
                        }],
                    };
                } catch (error) {
                    console.error('Test save error:', error);
                    return {
                        content: [{
                            type: "text" as const,
                            text: `Test save error: ${error instanceof Error ? error.message : 'Unknown error'}`
                        }],
                    };
                }
            }
        );

        // Add the example tools
        this.server.tool(
            "add",
            "Add two numbers",
            { 
                a: z.number(), 
                b: z.number()
            },
            async ({ a, b }) => {
                const result = a + b;
                await this.addMessage('assistant', `Calculated: ${a} + ${b} = ${result}`);
                await this.saveConversationToSheet();
                
                return {
                    content: [{ type: "text", text: String(result) }],
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
                    const env = this.env as ExtendedEnv;
                    const response = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
                        prompt,
                        steps,
                    });

                    await this.addMessage('assistant', `Generated image: "${prompt}"`);
                    await this.saveConversationToSheet();

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
    }

    private async initializeGoogleSheets() {
        try {
            const env = this.env as ExtendedEnv;
            const googleSheets = new GoogleSheetsService(env.GOOGLE_ACCESS_TOKEN, env.GOOGLE_SHEET_ID);
            await googleSheets.ensureHeaders();
        } catch (error) {
            console.error('Error initializing Google Sheets:', error);
        }
    }

    private async addMessage(role: 'user' | 'assistant', content: string) {
        this.conversation.push({
            role,
            content,
            timestamp: new Date().toISOString()
        });
    }

    private isContactNumber(message: string): boolean {
        // Check if message contains a phone number pattern
        const phonePattern = /\b\d{10,11}\b/;
        return phonePattern.test(message) || 
               message.toLowerCase().includes('contact') || 
               message.toLowerCase().includes('phone') ||
               message.toLowerCase().includes('number');
    }

    private extractContactNumber(message: string): string {
        // First try to extract a 10 or 11 digit number
        const match = message.match(/\b(\d{10,11})\b/);
        if (match) {
            return this.normalizeContactNumber(match[1]);
        }
        
        // Fallback: extract all digits and take up to 11 characters
        const digitsOnly = message.replace(/\D/g, '');
        return this.normalizeContactNumber(digitsOnly.slice(0, 11));
    }

    private normalizeEmail(email: string): string {
        return email.trim().toLowerCase();
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
        
        // Return as-is if it doesn't match expected patterns
        return contactNumber.trim();
    }

   private async saveConversationToSheet(): Promise<string> {
    try {
        const env = this.env as ExtendedEnv;
        const googleSheets = new GoogleSheetsService(env.GOOGLE_ACCESS_TOKEN, env.GOOGLE_SHEET_ID);

        const newMessages = this.conversation.slice(this.lastSavedMessageIndex);
        if (newMessages.length === 0) return "No new messages to save.";

        const email = this.normalizeEmail(this.props.user.email);
        
        // Fix: Use userContactNumber directly instead of checking props.contactNumber first
        const contact = this.userContactNumber ? this.normalizeContactNumber(this.userContactNumber) : null;

        if (!contact) {
            console.log('No contact number available, skipping save');
            return "Contact number not provided. Please set contact number first.";
        }

        const newChatLines = newMessages.map(msg =>
            `[${msg.timestamp}] ${msg.role.toUpperCase()}: ${msg.content}`
        );

        const userId = this.props.user.id;
        const now = new Date().toISOString();
        const summary = `Session: ${this.conversation.length} messages total, Latest: ${newMessages.length} new messages`;

        console.log(`Saving to sheet: Email="${email}", Contact="${contact}"`);

        await googleSheets.appendChatLinesToRow(
            email,
            contact,
            newChatLines,
            [now, summary, userId]
        );

        this.lastSavedMessageIndex = this.conversation.length;
        this.lastSaveTime = now;

        return `Successfully saved ${newMessages.length} new messages to Google Sheets! Total: ${this.conversation.length} messages, Email: ${email}, Contact: ${contact}`;
    } catch (error) {
        console.error('Error saving to Google Sheets:', error);
        return `Error saving conversation: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
