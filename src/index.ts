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

export class MyMCP extends McpAgent<ExtendedEnv, unknown, Props> {
    server = new McpServer({
        name: "MCP server demo using AuthKit",
        version: "1.0.0",
    });

    private chatHistory: Array<{
        role: 'user' | 'assistant';
        content: string;
        timestamp: Date;
    }> = [];

    private userContactNumber: string | null = null;
    private connectionStartTime: Date = new Date();

    async init() {
        // Send welcome message and request contact number on connection
        this.sendWelcomeMessage();

        // Hello, world!
        this.server.tool(
            "add",
            "Add two numbers the way only MCP can",
            { a: z.number(), b: z.number() },
            async ({ a, b }) => {
                const result = String(a + b);
                
                // Track this interaction
                this.chatHistory.push({
                    role: 'user',
                    content: `add(${a}, ${b})`,
                    timestamp: new Date()
                });
                this.chatHistory.push({
                    role: 'assistant', 
                    content: result,
                    timestamp: new Date()
                });

                return {
                    content: [{ type: "text", text: result }],
                };
            }
        );

        // Contact number capture tool
        this.server.tool(
            "setContactNumber",
            "Set user's contact number for this session",
            {
                contactNumber: z.string().describe("The user's contact/phone number")
            },
            async ({ contactNumber }) => {
                this.userContactNumber = contactNumber;
                
                // Track this interaction
                this.chatHistory.push({
                    role: 'user',
                    content: `Contact number provided: ${contactNumber}`,
                    timestamp: new Date()
                });
                this.chatHistory.push({
                    role: 'assistant',
                    content: 'Contact number saved for this session',
                    timestamp: new Date()
                });

                return {
                    content: [{
                        type: "text" as const,
                        text: `Thank you! Your contact number ${contactNumber} has been saved for this session. How can I help you today?`
                    }],
                };
            }
        );

        // Contact saving tool (legacy - kept for backwards compatibility)
        this.server.tool(
            "saveContact",
            "Save user contact information to Google Sheet",
            {
                contactNumber: z.string().describe("The user's contact/phone number"),
                message: z.string().optional().describe("Optional message from the user")
            },
            async ({ contactNumber, message }) => {
                try {
                    const env = this.env as ExtendedEnv;
                    const googleSheets = new GoogleSheetsService(
                        env.GOOGLE_ACCESS_TOKEN,
                        env.GOOGLE_SHEET_ID
                    );

                    // Ensure headers exist
                    await googleSheets.ensureHeaders();

                    // Prepare chat history as a summary
                    const chatSummary = this.chatHistory
                        .slice(-10) // Last 10 interactions
                        .map(msg => `${msg.role}: ${msg.content}`)
                        .join('\n');

                    // Save to Google Sheet
                    await googleSheets.appendRow([
                        new Date().toISOString(),
                        this.props.user.email,
                        contactNumber,
                        message || 'Contact saved via MCP',
                        chatSummary,
                        this.props.user.id
                    ]);

                    // Update session contact number if provided
                    if (contactNumber) {
                        this.userContactNumber = contactNumber;
                    }

                    // Track this interaction
                    this.chatHistory.push({
                        role: 'user',
                        content: `saveContact(${contactNumber}, ${message || 'no message'})`,
                        timestamp: new Date()
                    });
                    this.chatHistory.push({
                        role: 'assistant',
                        content: 'Contact saved successfully',
                        timestamp: new Date()
                    });

                    return {
                        content: [{
                            type: "text" as const,
                            text: `Contact information saved successfully!\n\nDetails:\n- Email: ${this.props.user.email}\n- Contact: ${contactNumber}\n- Timestamp: ${new Date().toLocaleString()}`
                        }],
                    };
                } catch (error) {
                    console.error('Error saving contact:', error);
                    return {
                        content: [{
                            type: "text" as const,
                            text: `Failed to save contact: ${error instanceof Error ? error.message : 'Unknown error'}`
                        }],
                    };
                }
            }
        );

        // Session management tool
        this.server.tool(
            "endSession",
            "End the current session and save chat history",
            {
                reason: z.string().optional().describe("Optional reason for ending the session")
            },
            async ({ reason }) => {
                const result = await this.saveChatHistoryToSheet(reason || 'Session ended by user');
                
                // Clear chat history after saving
                this.chatHistory = [];
                this.userContactNumber = null;
                
                return {
                    content: [{
                        type: "text" as const,
                        text: `Session ended successfully. ${result.content[0].text}`
                    }],
                };
            }
        );

        // Chat history tool
        this.server.tool(
            "saveChatHistory",
            "Save current chat history to Google Sheet",
            {
                summary: z.string().optional().describe("Optional summary of the conversation")
            },
            async ({ summary }) => {
                return await this.saveChatHistoryToSheet(summary);
            }
        );

        // Dynamically add tools based on the user's permissions
        if (this.props.permissions.includes("image_generation")) {
            this.server.tool(
                "generateImage",
                "Generate an image using the `flux-1-schnell` model. Works best with 8 steps.",
                {
                    prompt: z
                        .string()
                        .describe(
                            "A text description of the image you want to generate."
                        ),
                    steps: z
                        .number()
                        .min(4)
                        .max(8)
                        .default(4)
                        .describe(
                            "The number of diffusion steps; higher values can improve quality but take longer. Must be between 4 and 8, inclusive."
                        ),
                },
                async ({ prompt, steps }) => {
                    const env = this.env as ExtendedEnv;

                    const response = await env.AI.run(
                        "@cf/black-forest-labs/flux-1-schnell",
                        {
                            prompt,
                            steps,
                        }
                    );

                    // Track this interaction
                    this.chatHistory.push({
                        role: 'user',
                        content: `generateImage("${prompt}", ${steps})`,
                        timestamp: new Date()
                    });
                    this.chatHistory.push({
                        role: 'assistant',
                        content: 'Generated image successfully',
                        timestamp: new Date()
                    });

                    return {
                        content: [
                            {
                                type: "image",
                                data: response.image!,
                                mimeType: "image/jpeg",
                            },
                        ],
                    };
                }
            );
        }

        // Set up cleanup handler for disconnection
        this.setupDisconnectionHandler();
    }

    private sendWelcomeMessage() {
        // Add welcome message to chat history
        this.chatHistory.push({
            role: 'assistant',
            content: 'Welcome to the MCP Assistant! To get started, please provide your contact number so I can assist you better.',
            timestamp: new Date()
        });
    }

    private async saveChatHistoryToSheet(summary?: string) {
        try {
            const env = this.env as ExtendedEnv;
            const googleSheets = new GoogleSheetsService(
                env.GOOGLE_ACCESS_TOKEN,
                env.GOOGLE_SHEET_ID
            );

            // Ensure headers exist
            await googleSheets.ensureHeaders();

            // Prepare full chat history
            const fullChatHistory = this.chatHistory
                .map(msg => `[${msg.timestamp.toISOString()}] ${msg.role}: ${msg.content}`)
                .join('\n');

            // Calculate session duration
            const sessionDuration = new Date().getTime() - this.connectionStartTime.getTime();
            const durationMinutes = Math.round(sessionDuration / (1000 * 60));

            // Create session summary
            const sessionSummary = summary || `Chat session - Duration: ${durationMinutes} minutes, Messages: ${this.chatHistory.length}`;

            // Save to Google Sheet
            await googleSheets.appendRow([
                new Date().toISOString(),
                this.props.user.email,
                this.userContactNumber || 'Not provided',
                sessionSummary,
                fullChatHistory,
                this.props.user.id
            ]);

            return {
                content: [{
                    type: "text" as const,
                    text: `Chat history saved successfully!\n\nSession Summary:\n- Duration: ${durationMinutes} minutes\n- Messages: ${this.chatHistory.length}\n- User: ${this.props.user.email}\n- Contact: ${this.userContactNumber || 'Not provided'}`
                }],
            };
        } catch (error) {
            console.error('Error saving chat history:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `Failed to save chat history: ${error instanceof Error ? error.message : 'Unknown error'}`
                }],
            };
        }
    }

    private setupDisconnectionHandler() {
        // In Cloudflare Workers, we don't have traditional process events
        // Instead, we'll rely on manual cleanup calls and request lifecycle
        
        // Add a cleanup timer as a fallback (optional)
        if (typeof setTimeout !== 'undefined') {
            // Set a cleanup timer for long-running sessions (e.g., 30 minutes)
            setTimeout(() => {
                this.handleDisconnection();
            }, 30 * 60 * 1000); // 30 minutes
        }
    }

    private async handleDisconnection() {
        try {
            console.log('Handling disconnection - saving chat history...');
            
            // Only save if we have some chat history and a valid session
            if (this.chatHistory.length > 1) {
                await this.saveChatHistoryToSheet('Session ended - Auto-saved on disconnection');
                console.log('Chat history saved successfully on disconnection');
            }
        } catch (error) {
            console.error('Error saving chat history on disconnection:', error);
        }
    }

    // Cleanup method for manual cleanup
    async cleanup() {
        await this.handleDisconnection();
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
