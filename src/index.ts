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

// Session state interface
interface SessionState {
    conversation: ConversationMessage[];
    userContactNumber: string | null;
    sessionStartTime: string;
    lastSaveTime: string;
    lastSavedMessageIndex: number;
}

export class MyMCP extends McpAgent<ExtendedEnv, unknown, Props> {
    server = new McpServer({
        name: "MCP CRM Chat Assistant",
        version: "2.0.0",
    });

    // Use a key to store/retrieve session state
    private getSessionKey(): string {
        return `session_${this.props.user.id}`;
    }

    // Get session state from storage or create new one
    private async getSessionState(): Promise<SessionState> {
        const key = this.getSessionKey();
        const stored = await this.state.storage.get<SessionState>(key);
        
        if (stored) {
            return stored;
        }
        
        // Create new session state
        const newState: SessionState = {
            conversation: [],
            userContactNumber: null,
            sessionStartTime: new Date().toISOString(),
            lastSaveTime: new Date().toISOString(),
            lastSavedMessageIndex: 0
        };
        
        await this.state.storage.put(key, newState);
        return newState;
    }

    // Save session state to storage
    private async saveSessionState(state: SessionState): Promise<void> {
        const key = this.getSessionKey();
        await this.state.storage.put(key, state);
    }

    async init() {
        // Initialize session state
        const sessionState = await this.getSessionState();
        
        // Add welcome message if this is a new session
        if (sessionState.conversation.length === 0) {
            await this.addMessage('assistant', 'Welcome! Please provide your contact number to get started.');
        }
        
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
                const sessionState = await this.getSessionState();
                
                // Add both messages to conversation
                await this.addMessage('user', userMessage);
                await this.addMessage('assistant', assistantResponse);

                // Check if this is a contact number and update session state
                if (this.isContactNumber(userMessage)) {
                    sessionState.userContactNumber = this.extractContactNumber(userMessage);
                    await this.saveSessionState(sessionState);
                    console.log(`Contact number extracted and saved: ${sessionState.userContactNumber}`);
                }

                // Save to Google Sheets if requested
                if (saveToSheet) {
                    await this.saveConversationToSheet();
                }

                // Get updated session state for response
                const updatedState = await this.getSessionState();
                
                return {
                    content: [{
                        type: "text" as const,
                        text: `Conversation recorded: ${updatedState.conversation.length} messages total. Contact: ${updatedState.userContactNumber || 'Not set'}`
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
                const sessionState = await this.getSessionState();
                sessionState.userContactNumber = this.normalizeContactNumber(contactNumber);
                await this.saveSessionState(sessionState);
                
                await this.addMessage('assistant', `Contact number ${sessionState.userContactNumber} saved successfully.`);
                await this.saveConversationToSheet();
                
                return {
                    content: [{
                        type: "text" as const,
                        text: `Contact number ${sessionState.userContactNumber} has been saved.`
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
                const sessionState = await this.getSessionState();
                
                // Clear existing conversation
                sessionState.conversation = [];
                sessionState.lastSavedMessageIndex = 0;
                
                // Add all messages with timestamps
                for (const msg of messages) {
                    await this.addMessage(msg.role, msg.content);
                }

                // Extract contact number if present
                for (const msg of messages) {
                    if (msg.role === 'user' && this.isContactNumber(msg.content)) {
                        sessionState.userContactNumber = this.extractContactNumber(msg.content);
                        console.log(`Contact number found in import: ${sessionState.userContactNumber}`);
                        break;
                    }
                }

                await this.saveSessionState(sessionState);
                await this.saveConversationToSheet();

                return {
                    content: [{
                        type: "text" as const,
                        text: `Imported ${messages.length} messages. Contact: ${sessionState.userContactNumber || 'Not found'}`
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
                const sessionState = await this.getSessionState();
                const status = {
                    sessionStart: sessionState.sessionStartTime,
                    totalMessages: sessionState.conversation.length,
                    unsavedMessages: sessionState.conversation.length - sessionState.lastSavedMessageIndex,
                    contactNumber: sessionState.userContactNumber || 'Not set',
                    normalizedContact: sessionState.userContactNumber ? this.normalizeContactNumber(sessionState.userContactNumber) : 'N/A',
                    userEmail: this.props.user.email,
                    normalizedEmail: this.normalizeEmail(this.props.user.email),
                    lastSaved: sessionState.lastSaveTime
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
                    const sessionState = await this.getSessionState();
                    const email = this.normalizeEmail(this.props.user.email);
                    const contact = sessionState.userContactNumber ? this.normalizeContactNumber(sessionState.userContactNumber) : 'Not provided';
                    
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
        const sessionState = await this.getSessionState();
        sessionState.conversation.push({
            role,
            content,
            timestamp: new Date().toISOString()
        });
        await this.saveSessionState(sessionState);
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
            const sessionState = await this.getSessionState();

            const newMessages = sessionState.conversation.slice(sessionState.lastSavedMessageIndex);
            if (newMessages.length === 0) return "No new messages to save.";

            const email = this.normalizeEmail(this.props.user.email);
            const contact = sessionState.userContactNumber ? this.normalizeContactNumber(sessionState.userContactNumber) : null;

            if (!contact) {
                console.log('No contact number available, skipping save');
                return "Contact number not provided. Please set contact number first.";
            }

            const newChatLines = newMessages.map(msg =>
                `[${msg.timestamp}] ${msg.role.toUpperCase()}: ${msg.content}`
            );

            const userId = this.props.user.id;
            const now = new Date().toISOString();
            const summary = `Session: ${sessionState.conversation.length} messages total, Latest: ${newMessages.length} new messages`;

            console.log(`Saving to sheet: Email="${email}", Contact="${contact}"`);

            await googleSheets.appendChatLinesToRow(
                email,
                contact,
                newChatLines,
                [now, summary, userId]
            );

            // Update session state
            sessionState.lastSavedMessageIndex = sessionState.conversation.length;
            sessionState.lastSaveTime = now;
            await this.saveSessionState(sessionState);

            return `Successfully saved ${newMessages.length} new messages to Google Sheets! Total: ${sessionState.conversation.length} messages, Email: ${email}, Contact: ${contact}`;
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
