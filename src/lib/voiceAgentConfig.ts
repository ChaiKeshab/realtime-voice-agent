export const MODEL = "gpt-4o-mini-realtime-preview";
export const BASE_URL = "https://api.openai.com/v1/realtime";

// https://platform.openai.com/docs/guides/function-calling
export const toolsDefinition = [
    {
        name: "navigate",
        description: "Navigate to a specific page in the app",
        parameters: {
            type: "object",
            properties: {
                page: {
                    type: "string",
                    enum: ["/", "/about"],
                    description: "Page path to navigate to",
                },
            },
            required: ["page"],
        },
    },
];

export const TOOLS = toolsDefinition.map((tool) => ({
    type: "function" as const,
    ...tool,
}))


export const INSTRUCTIONS = `
You are a software assistant. Respond in English.

Tool:
- navigate(page: "/", "/about") → switch app page.

Use the tool only when user requests a page change. Otherwise, answer normally.
`;
