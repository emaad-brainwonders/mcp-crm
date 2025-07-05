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

    async init() {
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

        // Contact saving tool
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
                            type: "text",
                            text: `Contact information saved successfully!\n\nDetails:\n- Email: ${this.props.user.email}\n- Contact: ${contactNumber}\n- Timestamp: ${new Date().toLocaleString()}`
                        }],
                    };
                } catch (error) {
                    console.error('Error saving contact:', error);
                    return {
                        content: [{
                            type: "text",
                            text: `Failed to save contact: ${error instanceof Error ? error.message : 'Unknown error'}`
                        }],
                    };
                }
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

                    // Save to Google Sheet
                    await googleSheets.appendRow([
                        new Date().toISOString(),
                        this.props.user.email,
                        '', // No contact number for this entry
                        summary || 'Chat history save',
                        fullChatHistory,
                        this.props.user.id
                    ]);

                    return {
                        content: [{
                            type: "text",
                            text: `Chat history saved successfully!\n\nSaved ${this.chatHistory.length} interactions for user: ${this.props.user.email}`
                        }],
                    };
                } catch (error) {
                    console.error('Error saving chat history:', error);
                    return {
                        content: [{
                            type: "text",
                            text: `Failed to save chat history: ${error instanceof Error ? error.message : 'Unknown error'}`
                        }],
                    };
                }
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
