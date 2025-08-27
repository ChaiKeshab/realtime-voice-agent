
export type ToolCallOutput = {
    response: string;
    [key: string]: unknown;
};

// the response order of bot and user is inconsistent
export interface MessagesType {
    id: string;
    bot?: string;
    user?: string
    // role: 'assistant' | 'user';
}

export interface ToolCallType {
    name: string;
    arguments: string;
}

type AssistantContent = {
    type: "audio";
    transcript: string;
};

export type AssistantMessage = {
    id: string;
    object: "realtime.item";
    type: "message";
    status: "completed";
    role: "assistant";
    content: AssistantContent[];
};

type FunctionCallMessage = {
    id: string;
    object: "realtime.item";
    type: "function_call";
    status: "completed";
    name: string;
    call_id: string;
    arguments: string;
};

export type ResponseDoneOutputType = AssistantMessage | FunctionCallMessage;


// --- Shared Nested Types ---
type AudioTranscription = {
    model?: string; // optional
};

type TurnDetection = {
    type?: "server_vad";
    threshold?: number;
    prefix_padding_ms?: number;
    silence_duration_ms?: number;
    create_response?: boolean;
};

type ToolParameter = {
    type?: string;
    properties?: Record<string, { type: string }>;
    required?: string[];
};

type Tool = {
    type?: "function";
    name?: string;
    description?: string;
    parameters?: ToolParameter;
};

type Session = {
    modalities?: ("text" | "audio")[];
    instructions?: string;
    voice?: string;
    input_audio_format?: string;
    output_audio_format?: string;
    input_audio_transcription?: AudioTranscription;
    turn_detection?: TurnDetection;
    tools?: Tool[];
    tool_choice?: "auto" | string;
    temperature?: number;
    max_response_output_tokens?: string | number;
    speed?: number;
    tracing?: string;
};

type Response = {
    modalities?: ("text" | "audio")[];
    instructions?: string;
    voice?: string;
    output_audio_format?: string;
    tools?: Tool[];
    tool_choice?: "auto" | string;
    temperature?: number;
    max_output_tokens?: number;
};

// --- Message Item ---
type MessageContent =
    | { type: "input_text"; text?: string }
    | { type: "input_audio"; audio_url?: string };


// https://platform.openai.com/docs/api-reference/realtime_client_events/response/create
type Item = {
    id?: string;
    arguments?: string;
    call_id?: string;
    type?: "message" | "function_call" | "function_call_output";
    role?: "user" | "assistant" | "system"; //only applicable for message items.
    content?: MessageContent[];
    output: string;
};

// --- Event Types ---
type SessionUpdateEvent = {
    type: "session.update";
    event_id?: string;
    session?: Partial<Session>;
};

type ConversationItemCreateEvent = {
    type: "conversation.item.create";
    event_id?: string;
    previous_item_id?: string | null;
    item?: Partial<Item>;
};

type ResponseCreateEvent = {
    type: "response.create";
    event_id?: string;
    response?: Partial<Response>;
};


export type RealtimeEvent =
    | SessionUpdateEvent
    | ConversationItemCreateEvent
    | ResponseCreateEvent;

