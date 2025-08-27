import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { FaMicrophone, FaMicrophoneSlash } from "react-icons/fa6";
import { IoMdClose } from "react-icons/io";
import type { AssistantMessage, MessagesType, RealtimeEvent, ResponseDoneOutputType, ToolCallOutput, ToolCallType } from "./openaiTypes";
import { BASE_URL, INSTRUCTIONS, MODEL, TOOLS } from "../../lib/voiceAgentConfig";
import { gptImg } from "../../assets";
import useLockBodyScroll from "../../hooks/useLockBodyScroll";


export default function RealtimeChat() {
    const navigate = useNavigate();

    const [messages, setMessages] = useState<MessagesType[]>([]);
    const [toolCall, setToolCall] = useState<ToolCallType | null>(null);
    console.log(toolCall)
    const [isSessionStarted, setIsSessionStarted] = useState(false);
    const [isSessionActive, setIsSessionActive] = useState(false);
    const [isListening, setIsListening] = useState(false);

    const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
    const peerConnection = useRef<RTCPeerConnection | null>(null);
    const audioElement = useRef<HTMLAudioElement | null>(null);
    const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
    const audioTransceiver = useRef<RTCRtpTransceiver | null>(null);
    const tracks = useRef<RTCRtpSender[] | null>(null);

    /** 
     * Synchronization Issue: Speech and Transcription Models
     * 
     * The speech model (gpt-4o-mini-realtime-preview) and transcription model 
     * (gpt-4o-mini-transcribe) operate as separate services without shared session 
     * identifiers. This architectural limitation creates race conditions and message 
     * ordering issues in the user-agent conversation flow.
     * 
     * Solution: Implement a completion state manager that tracks both model responses
     * and only advances the conversation cycle after receiving final events from both
     * services, ensuring proper message sequencing and chat history integrity.
     */
    const currentMessageId = useRef<string | null>(null);
    const completionState = useRef({ responseDone: false, transcriptionDone: false });


    const resetMessageCycle = () => {
        if (completionState.current.responseDone && completionState.current.transcriptionDone) {
            currentMessageId.current = null;
            completionState.current = { responseDone: false, transcriptionDone: false };
        }
    };
    /** */

    async function startSession() {
        try {
            if (!isSessionStarted) {

                const session = await fetch("http://localhost:8080/api/realtime/session").then((response) =>
                    response.json()
                );
                const sessionToken = session.client_secret.value;
                if (sessionToken) {
                    setIsSessionStarted(true)
                }

                const pc = new RTCPeerConnection();

                if (!audioElement.current) {
                    audioElement.current = document.createElement("audio");
                }
                audioElement.current.autoplay = true;
                pc.ontrack = (e) => {
                    if (audioElement.current) {
                        audioElement.current.srcObject = e.streams[0];
                    }
                };

                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                });

                stream.getTracks().forEach((track) => {
                    const sender = pc.addTrack(track, stream);
                    if (sender) {
                        tracks.current = [...(tracks.current || []), sender];
                    }
                });

                // data channel for sending and receiving events
                const dc = pc.createDataChannel("oai-events");
                setDataChannel(dc);

                // init session using Session Description Protocol (SDP)
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                const sdpResponse = await fetch(`${BASE_URL}?model=${MODEL}`, {
                    method: "POST",
                    body: offer.sdp,
                    headers: {
                        Authorization: `Bearer ${sessionToken}`,
                        "Content-Type": "application/sdp",
                    },
                });

                const answer: RTCSessionDescriptionInit = {
                    type: "answer",
                    sdp: await sdpResponse.text(),
                };
                await pc.setRemoteDescription(answer);

                peerConnection.current = pc;
            }
        } catch (error) {
            console.error("Error starting session:", error);
            setIsSessionStarted(false)
        }
    }

    function stopSession() {
        // clean up peer connection and data channel
        if (dataChannel) {
            dataChannel.close();
        }
        if (peerConnection.current) {
            peerConnection.current.close();
        }

        setIsSessionStarted(false);
        setIsSessionActive(false);
        setDataChannel(null);
        peerConnection.current = null;
        if (audioStream) {
            audioStream.getTracks().forEach((track) => track.stop());
        }
        setAudioStream(null);
        setIsListening(false);
        audioTransceiver.current = null;
    }

    // Grabs a new mic track and replaces the placeholder track in the transceiver
    async function startRecording() {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });
            setAudioStream(newStream);

            // if we already have an audioSender, just replace its track:
            if (tracks.current) {
                const micTrack = newStream.getAudioTracks()[0];
                tracks.current.forEach((sender) => {
                    sender.replaceTrack(micTrack);
                });
            } else if (peerConnection.current) {
                // fallback if audioSender somehow didn't get set
                newStream.getTracks().forEach((track) => {
                    const sender = peerConnection.current?.addTrack(track, newStream);
                    if (sender) {
                        tracks.current = [...(tracks.current || []), sender];
                    }
                });
            }

            setIsListening(true);
            console.log("Microphone started.");
        } catch (error) {
            console.error("Error accessing microphone:", error);
        }
    }

    // Replaces the mic track with a placeholder track
    function stopRecording() {
        setIsListening(false);

        // Stop existing mic tracks so the user’s mic is off
        if (audioStream) {
            audioStream.getTracks().forEach((track) => track.stop());
        }
        setAudioStream(null);

        // Replace with a placeholder (silent) track
        if (tracks.current) {
            const placeholderTrack = createEmptyAudioTrack();
            tracks.current.forEach((sender) => {
                sender.replaceTrack(placeholderTrack);
            });
        }
    }

    // Creates a placeholder track that is silent
    function createEmptyAudioTrack(): MediaStreamTrack {
        const audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
        return destination.stream.getAudioTracks()[0];
    }

    // Send a message to the model
    const sendClientEvent = useCallback((message: RealtimeEvent) => {
        if (dataChannel) {
            message.event_id = message.event_id || crypto.randomUUID();
            dataChannel.send(JSON.stringify(message));
        } else {
            console.error("Failed to send message - no data channel available", message);
        }
    }, [dataChannel]);


    interface ResponseDoneFnOutput {
        id: string;
        object: "realtime.item";
        type: "function_call";
        status: string
        name: string;
        call_id: string;
        arguments: string; // JSON string like "{\"page\":\"/about\"}"
    }

    useEffect(() => {
        async function handleToolCall<T extends ResponseDoneFnOutput>(output: T) {
            const toolCall = {
                name: output.name,
                arguments: output.arguments,
            };
            // { "name": "navigate", "arguments": "{\"page\":\"/about\"}" }
            setToolCall(toolCall);

            const toolCallOutput: ToolCallOutput = {
                response: `Tool call ${toolCall.name} executed successfully.`,
            };

            if (toolCall.name === "navigate") {
                const args =
                    typeof toolCall.arguments === "string"
                        ? JSON.parse(toolCall.arguments)
                        : toolCall.arguments;

                const page = args.page;

                if (page) {
                    navigate(page);
                }
            }

            sendClientEvent({
                type: "conversation.item.create",
                item: {
                    type: "function_call_output",
                    call_id: output.call_id,
                    output: JSON.stringify(toolCallOutput),
                },
            });

            if (toolCall.name === "navigate") {
                sendClientEvent({
                    type: "response.create",
                });
            }
        }

        if (!dataChannel) return;
        const handleMessage = (e: MessageEvent) => {
            const event = JSON.parse(e.data);
            const output: ResponseDoneOutputType = event.response?.output?.[0];
            const transcript = event.transcript;

            // console.log(currentMessageId.current)
            if ((event.type === "response.audio_transcript.delta" ||
                event.type === "conversation.item.input_audio_transcription.delta") &&
                !currentMessageId.current) {
                currentMessageId.current = crypto.randomUUID();
            }
            switch (event.type) {
                case "response.audio_transcript.delta":
                    handleBotDelta(event.delta);
                    break;

                case "conversation.item.input_audio_transcription.delta":
                    handleUserDelta(event.delta);
                    break;

                case "response.done":
                    if (output) {
                        handleResponseDone(output);
                        completionState.current.responseDone = true;
                        if (completionState.current.transcriptionDone) {
                            resetMessageCycle();
                        }
                    }
                    break;

                case "conversation.item.input_audio_transcription.completed":
                    if (transcript) {
                        handleUserTranscriptionComplete(transcript);
                        completionState.current.transcriptionDone = true;
                        if (completionState.current.responseDone) {
                            resetMessageCycle();
                        }
                    }
                    break;

                default:
                    break;
            }
        };

        const handleBotDelta = (delta: string) => {
            if (!delta) return;

            setMessages((prev) => {
                const deltaIndex = prev.findIndex(msg => msg.id === currentMessageId.current);

                if (deltaIndex !== -1) {
                    const updated = [...prev];
                    updated[deltaIndex] = {
                        ...updated[deltaIndex],
                        bot: (updated[deltaIndex].bot || '') + delta,
                    };
                    return updated;
                }

                return [
                    {
                        id: currentMessageId.current!,
                        bot: delta,
                    },
                    ...prev,
                ];
            });
        };

        const handleUserDelta = (transcript: string) => {
            if (!transcript) return;

            setMessages((prev) => {

                const deltaIndex = prev.findIndex(msg => msg.id === currentMessageId.current);

                if (deltaIndex !== -1) {
                    const updated = [...prev];
                    updated[deltaIndex] = {
                        ...updated[deltaIndex],
                        user: (updated[deltaIndex].user || '') + transcript,
                    };
                    return updated;
                }

                return [
                    {
                        id: currentMessageId.current!,
                        user: transcript,
                    },
                    ...prev,
                ];
            });
        };

        const handleUserTranscriptionComplete = (transcript: string) => {
            if (!transcript) return;

            setMessages((prev) => {
                const deltaIndex = prev.findIndex(msg => msg.id === currentMessageId.current);

                if (deltaIndex !== -1) {
                    const updated = [...prev];
                    updated[deltaIndex] = {
                        ...updated[deltaIndex],
                        user: transcript,
                    };
                    return updated;
                }
                return prev

            });

        };

        const handleResponseDone = (output: ResponseDoneOutputType) => {
            if (!output) return;
            if (output.type === "message") {
                handleBotMessageComplete(output);
            } else if (output.type === "function_call") {
                handleToolCall(output);
            }
        };

        const handleBotMessageComplete = (output: AssistantMessage) => {
            const finalTranscript = output?.content?.[0]?.transcript;
            if (!finalTranscript) return;

            setMessages((prev) => {
                const deltaIndex = prev.findIndex(msg => msg.id === currentMessageId.current);

                if (deltaIndex !== -1) {
                    const updated = [...prev];
                    updated[deltaIndex] = {
                        ...updated[deltaIndex],
                        id: output.id,
                        bot: finalTranscript,
                    };
                    return updated;
                }

                return prev
            });
        };

        const handleOpen = () => {
            setIsSessionActive(true);
            setIsListening(true);
            const sessionUpdate = {
                type: "session.update" as const,
                session: {
                    tools: TOOLS,
                    instructions: INSTRUCTIONS,
                    "input_audio_transcription": {
                        "model": "gpt-4o-mini-transcribe"
                    },
                    "max_response_output_tokens": 300
                },
            };
            sendClientEvent(sessionUpdate);
            console.log("Session update sent:", sessionUpdate);
        };

        dataChannel.addEventListener("message", handleMessage);
        dataChannel.addEventListener("open", handleOpen);

        return () => {
            dataChannel.removeEventListener("message", handleMessage);
            dataChannel.removeEventListener("open", handleOpen);
        };
    }, [dataChannel, sendClientEvent, navigate]);

    const handleConnectClick = async () => {
        if (isSessionActive) {
            console.log("Stopping session.");
            stopSession();
        } else {
            console.log("Starting session.");
            startSession();
        }
    };

    const handleMicToggleClick = async () => {
        if (isListening) {
            console.log("Stopping microphone.");
            stopRecording();
        } else {
            console.log("Starting microphone.");
            startRecording();
        }
    };


    return (
        <>
            {isSessionActive &&
                <ChatView
                    messages={messages}
                    isConnected={isSessionActive}
                    isListening={isListening}
                    handleConnectClick={handleConnectClick}
                    handleMicToggleClick={handleMicToggleClick}
                />
            }

            <div className="fixed z-10 right-4 bottom-4">
                <button
                    className={`p-3 ${isSessionActive ? 'bg-green-400' : " bg-white"} rounded-full border border-gray-400 flex items-center justify-center cursor-pointer`}
                    onClick={handleConnectClick}
                >
                    <img src={gptImg} className="w-8 h-8" alt="chat gpt" />
                </button>
            </div>
        </>
    );
}

interface ControlsProps {
    messages: MessagesType[];
    isConnected: boolean;
    isListening: boolean;
    handleConnectClick: () => void;
    handleMicToggleClick: () => void;
}


const ChatView: React.FC<ControlsProps> = ({
    messages,
    isConnected,
    isListening,
    handleConnectClick,
    handleMicToggleClick
}) => {

    useLockBodyScroll(true);
    if (!isConnected) {
        return null;
    }

    const handleConnectionToggle = () => {
        handleConnectClick();
    };

    return (
        <div className="fixed inset-0 z-50 w-full h-full bg-[#212121] flex flex-col">
            {/* Header */}

            <div className="p-4 bg-[#212121]">
                <div className="flex items-center justify-between">
                    <h2 className="text-xl font-semibold text-white">Voice Chat</h2>
                    <div className="flex items-center gap-2">
                        <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
                        <span className="text-sm text-gray-300">
                            {isConnected ? 'Connected' : 'Disconnected'}
                        </span>
                    </div>
                </div>
            </div>

            {/* Messages Container */}
            <div className="flex-1 overflow-y-auto [color-scheme:dark] p-4">
                <div className="max-w-4xl mx-auto">
                    <div className="flex flex-col gap-4">
                        {messages.length === 0 ? (
                            <div className="text-center text-gray-400 py-8">
                                <p>Start speaking to begin your conversation...</p>
                            </div>
                        ) : (
                            (() => {
                                const elements = [];

                                for (let i = messages.length - 1; i >= 0; i--) {
                                    const msg = messages[i];
                                    elements.push(
                                        <div key={msg.id} className="flex flex-col gap-3">
                                            {msg.user && (
                                                <div className="flex justify-end">
                                                    <div className="max-w-xs md:max-w-md lg:max-w-lg xl:max-w-xl p-3 rounded-2xl bg-blue-600 text-white shadow-lg">
                                                        <p className="text-sm leading-relaxed">{msg.user}</p>
                                                    </div>
                                                </div>
                                            )}
                                            {msg.bot && (
                                                <div className="flex justify-start">
                                                    <div className="max-w-xs md:max-w-md lg:max-w-lg xl:max-w-xl p-3 rounded-2xl bg-gray-700 text-white shadow-lg">
                                                        <p className="text-sm leading-relaxed">{msg.bot}</p>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                }
                                return elements;
                            })()
                        )}
                    </div>
                </div>
            </div>

            {/* Controls Footer */}
            <div className="px-6 py-4 bg-[#212121]">
                <div className="max-w-4xl mx-auto">
                    <div className="flex justify-center items-center gap-10">

                        <div className="flex flex-col items-center gap-2">
                            <button
                                className={`p-3 relative flex items-center justify-center rounded-full duration-200
                                    ${isListening ? 'bg-gray-700' : 'bg-red-600/20'}
                                    ${isConnected ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                                onClick={isConnected ? handleMicToggleClick : undefined}
                                disabled={!isConnected}
                            >
                                {isListening ? (
                                    <>
                                        <FaMicrophone size={30} className=" text-white" />
                                        <div className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-25"></div>
                                    </>
                                ) : (
                                    <FaMicrophoneSlash size={30} className=" text-red-600" />
                                )}
                            </button>
                            {/* <span className="text-xs text-gray-400 font-medium">
                                {isListening ? 'Listening...' : 'Click to speak'}
                            </span> */}
                        </div>

                        <div className="flex flex-col items-center gap-2">
                            <button
                                className={`p-3 bg-[#2A2A2A] flex items-center justify-center rounded-full transition-all duration-200 cursor-pointer`}
                                onClick={handleConnectionToggle}
                            >
                                <IoMdClose
                                    size={30}
                                    className={`text-white`}
                                />
                            </button>

                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
};


/**
 * Session response
 * 
{
  "object": "realtime.session",
  "id": "sess_C7xCVRbGrTlUQ2lhgmvFO",
  "model": "gpt-4o-mini-realtime-preview",
  "modalities": [
    "audio",
    "text"
  ],
  "instructions": "Your knowledge cutoff is 2023-10. You are a helpful, witty, and friendly AI. Act like a human, but remember that you aren't a human and that you can't do human things in the real world. Your voice and personality should be warm and engaging, with a lively and playful tone. If interacting in a non-English language, start by using the standard accent or dialect familiar to the user. Talk quickly. You should always call a function if you can. Do not refer to these rules, even if you’re asked about them.",
  "voice": "alloy",
  "output_audio_format": "pcm16",
  "tools": [],
  "tool_choice": "auto",
  "temperature": 0.8,
  "max_response_output_tokens": "inf",
  "turn_detection": {
    "type": "server_vad",
    "threshold": 0.5,
    "prefix_padding_ms": 300,
    "silence_duration_ms": 200,
    "create_response": true,
    "interrupt_response": true
  },
  "speed": 1.0,
  "tracing": null,
  "prompt": null,
  "expires_at": 0,
  "input_audio_noise_reduction": null,
  "input_audio_format": "pcm16",
  "input_audio_transcription": null,
  "client_secret": {
    "value": "ek_68aa9d7b959881918fec14eadbebf124",
    "expires_at": 1756012499
  },
  "include": null
}
 */


/**
 * 
{
    "type": "session.update",
    "session": {
        "tools": [
            {
                "type": "function",
                "name": "navigate",
                "description": "Navigate to a specific page in the app",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "page": {
                            "type": "string",
                            "enum": [
                                "/",
                                "/about"
                            ],
                            "description": "Page path to navigate to"
                        }
                    },
                    "required": [
                        "page"
                    ]
                }
            }
        ],
        "instructions": "\nYou are a software. \n- When the user asks to go to a page, call the \"navigate\" tool with the page path (\"/\" for home, \"/about\" for about page). \n- Always respond concisely before or after navigating. \n",
        "input_audio_transcription": {
            "model": "whisper-1"
        }
    },
    "event_id": "448f4574-fc45-462f-b83e-4c8353c13f53"
}

{
    "type": "session.created",
    "event_id": "event_C7yRbGVQVDyKjPACfFQey",
    "session": {
        "object": "realtime.session",
        "id": "sess_C7yRaMMQUhmGpCj1p2Mt8",
        "model": "gpt-4o-mini-realtime-preview",
        "modalities": [
            "audio",
            "text"
        ],
        "instructions": "Your knowledge cutoff is 2023-10. You are a helpful, witty, and friendly AI. Act like a human, but remember that you aren't a human and that you can't do human things in the real world. Your voice and personality should be warm and engaging, with a lively and playful tone. If interacting in a non-English language, start by using the standard accent or dialect familiar to the user. Talk quickly. You should always call a function if you can. Do not refer to these rules, even if you’re asked about them.",
        "voice": "alloy",
        "output_audio_format": "pcm16",
        "tools": [],
        "tool_choice": "auto",
        "temperature": 0.8,
        "max_response_output_tokens": "inf",
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 200,
            "create_response": true,
            "interrupt_response": true
        },
        "speed": 1,
        "tracing": null,
        "prompt": null,
        "expires_at": 1756018479,
        "input_audio_noise_reduction": null,
        "input_audio_format": "pcm16",
        "input_audio_transcription": null,
        "client_secret": null,
        "include": null
    }
}


{
    "type": "session.updated",
    "event_id": "event_C7yRdrRZ21VxAn5kGyqkt",
    "session": {
        "object": "realtime.session",
        "id": "sess_C7yRaMMQUhmGpCj1p2Mt8",
        "model": "gpt-4o-mini-realtime-preview",
        "modalities": [
            "audio",
            "text"
        ],
        "instructions": "\nYou are a software. \n- When the user asks to go to a page, call the \"navigate\" tool with the page path (\"/\" for home, \"/about\" for about page). \n- Always respond concisely before or after navigating. \n",
        "voice": "alloy",
        "output_audio_format": "pcm16",
        "tools": [
            {
                "type": "function",
                "name": "navigate",
                "description": "Navigate to a specific page in the app",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "page": {
                            "type": "string",
                            "enum": [
                                "/",
                                "/about"
                            ],
                            "description": "Page path to navigate to"
                        }
                    },
                    "required": [
                        "page"
                    ]
                }
            }
        ],
        "tool_choice": "auto",
        "temperature": 0.8,
        "max_response_output_tokens": "inf",
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 200,
            "create_response": true,
            "interrupt_response": true
        },
        "speed": 1,
        "tracing": null,
        "prompt": null,
        "expires_at": 1756018479,
        "input_audio_noise_reduction": null,
        "input_audio_format": "pcm16",
        "input_audio_transcription": {
            "model": "whisper-1",
            "language": null,
            "prompt": null
        },
        "client_secret": null,
        "include": null
    }
}

{
    "type": "input_audio_buffer.speech_started",
    "event_id": "event_C7yRffT25hs8xsx2kVzxf",
    "audio_start_ms": 1972,
    "item_id": "item_C7yRf7l29gNUytSg6YbtS"
}

{
    "type": "input_audio_buffer.speech_stopped",
    "event_id": "event_C7yRgkDDOm21Hj9eWdz1I",
    "audio_end_ms": 3520,
    "item_id": "item_C7yRf7l29gNUytSg6YbtS"
}

{
    "type": "input_audio_buffer.committed",
    "event_id": "event_C7yRgyfdZWfrVWXzCygfV",
    "previous_item_id": null,
    "item_id": "item_C7yRf7l29gNUytSg6YbtS"
}

{
    "type": "conversation.item.created",
    "event_id": "event_C7yRgpOKWsDMMC3jAIhl5",
    "previous_item_id": null,
    "item": {
        "id": "item_C7yRf7l29gNUytSg6YbtS",
        "object": "realtime.item",
        "type": "message",
        "status": "completed",
        "role": "user",
        "content": [
            {
                "type": "input_audio",
                "transcript": null
            }
        ]
    }
}

{
    "type": "response.created",
    "event_id": "event_C7yRgrOaSziOkY0yd6yTx",
    "response": {
        "object": "realtime.response",
        "id": "resp_C7yRg78p1IoKl2sQc77bC",
        "status": "in_progress",
        "status_details": null,
        "output": [],
        "conversation_id": "conv_C7yRby6shRAT5ipEOO4AN",
        "modalities": [
            "text",
            "audio"
        ],
        "voice": "alloy",
        "output_audio_format": "pcm16",
        "temperature": 0.8,
        "max_output_tokens": "inf",
        "usage": null,
        "metadata": null
    }
}


{
    "type": "response.output_item.added",
    "event_id": "event_C7yRgDLwKYZM29OuwYaMJ",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC",
    "output_index": 0,
    "item": {
        "id": "item_C7yRgcGqrTO7TehbpQkj9",
        "object": "realtime.item",
        "type": "message",
        "status": "in_progress",
        "role": "assistant",
        "content": []
    }
}


{
    "type": "conversation.item.created",
    "event_id": "event_C7yRgkxAxV7Mxka22Zlbe",
    "previous_item_id": "item_C7yRf7l29gNUytSg6YbtS",
    "item": {
        "id": "item_C7yRgcGqrTO7TehbpQkj9",
        "object": "realtime.item",
        "type": "message",
        "status": "in_progress",
        "role": "assistant",
        "content": []
    }
}

{
    "type": "response.content_part.added",
    "event_id": "event_C7yRgizrlqZSnkuS9p7ai",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC",
    "item_id": "item_C7yRgcGqrTO7TehbpQkj9",
    "output_index": 0,
    "content_index": 0,
    "part": {
        "type": "audio",
        "transcript": ""
    }
}


{
    "type": "response.audio_transcript.delta",
    "event_id": "event_C7yRgVnF9bPdnHERwrWpY",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC",
    "item_id": "item_C7yRgcGqrTO7TehbpQkj9",
    "output_index": 0,
    "content_index": 0,
    "delta": "I'm",
    "obfuscation": "SZo0PESyHqsCm"
}

{
    "type": "response.audio_transcript.delta",
    "event_id": "event_C7yRgQabv75n0VPXwTgrE",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC",
    "item_id": "item_C7yRgcGqrTO7TehbpQkj9",
    "output_index": 0,
    "content_index": 0,
    "delta": " doing",
    "obfuscation": "zUlDgpX6fS"
}
...
{
    "type": "response.audio_transcript.delta",
    "event_id": "event_C7yRh2qyrIwfv2EfHiAKa",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC",
    "item_id": "item_C7yRgcGqrTO7TehbpQkj9",
    "output_index": 0,
    "content_index": 0,
    "delta": "?",
    "obfuscation": "PBkckBOFn2qu17g"
}

{
    "type": "response.audio.done",
    "event_id": "event_C7yRhHg6S5EoCT4qphxdc",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC",
    "item_id": "item_C7yRgcGqrTO7TehbpQkj9",
    "output_index": 0,
    "content_index": 0
}

{
    "type": "response.audio_transcript.done",
    "event_id": "event_C7yRhga3mCREX1Jtjx9lC",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC",
    "item_id": "item_C7yRgcGqrTO7TehbpQkj9",
    "output_index": 0,
    "content_index": 0,
    "transcript": "I'm doing well, thank you! How about you?"
}

{
    "type": "response.content_part.done",
    "event_id": "event_C7yRhp960AKaeoF7bRBDF",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC",
    "item_id": "item_C7yRgcGqrTO7TehbpQkj9",
    "output_index": 0,
    "content_index": 0,
    "part": {
        "type": "audio",
        "transcript": "I'm doing well, thank you! How about you?"
    }
}

{
    "type": "response.output_item.done",
    "event_id": "event_C7yRh6bveS01vWAk2agsp",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC",
    "output_index": 0,
    "item": {
        "id": "item_C7yRgcGqrTO7TehbpQkj9",
        "object": "realtime.item",
        "type": "message",
        "status": "completed",
        "role": "assistant",
        "content": [
            {
                "type": "audio",
                "transcript": "I'm doing well, thank you! How about you?"
            }
        ]
    }
}

{
    "type": "response.done",
    "event_id": "event_C7yRhTBW4Uw2xR51T1ngV",
    "response": {
        "object": "realtime.response",
        "id": "resp_C7yRg78p1IoKl2sQc77bC",
        "status": "completed",
        "status_details": null,
        "output": [
            {
                "id": "item_C7yRgcGqrTO7TehbpQkj9",
                "object": "realtime.item",
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {
                        "type": "audio",
                        "transcript": "I'm doing well, thank you! How about you?"
                    }
                ]
            }
        ],
        "conversation_id": "conv_C7yRby6shRAT5ipEOO4AN",
        "modalities": [
            "text",
            "audio"
        ],
        "voice": "alloy",
        "output_audio_format": "pcm16",
        "temperature": 0.8,
        "max_output_tokens": "inf",
        "usage": {
            "total_tokens": 191,
            "input_tokens": 122,
            "output_tokens": 69,
            "input_token_details": {
                "text_tokens": 107,
                "audio_tokens": 15,
                "image_tokens": 0,
                "cached_tokens": 0,
                "cached_tokens_details": {
                    "text_tokens": 0,
                    "audio_tokens": 0,
                    "image_tokens": 0
                }
            },
            "output_token_details": {
                "text_tokens": 21,
                "audio_tokens": 48
            }
        },
        "metadata": null
    }
}

[
    {
        "id": "item_C7yRgcGqrTO7TehbpQkj9",
        "object": "realtime.item",
        "type": "message",
        "status": "completed",
        "role": "assistant",
        "content": [
            {
                "type": "audio",
                "transcript": "I'm doing well, thank you! How about you?"
            }
        ]
    }
]

[
    {
        "id": "item_C7yRgcGqrTO7TehbpQkj9",
        "object": "realtime.item",
        "type": "message",
        "status": "completed",
        "role": "assistant",
        "content": [
            {
                "type": "audio",
                "transcript": "I'm doing well, thank you! How about you?"
            }
        ]
    }
]

{
    "type": "rate_limits.updated",
    "event_id": "event_C7yRhfbgc47Fg4QhDYKtS",
    "rate_limits": [
        {
            "name": "tokens",
            "limit": 40000,
            "remaining": 39518,
            "reset_seconds": 0.723
        }
    ]
}

{
    "type": "conversation.item.input_audio_transcription.delta",
    "event_id": "event_C7yRiq2gDhmFxohGpNxl4",
    "item_id": "item_C7yRf7l29gNUytSg6YbtS",
    "content_index": 0,
    "delta": "How are you?",
    "obfuscation": "5AZ3"
}

{
    "type": "conversation.item.input_audio_transcription.completed",
    "event_id": "event_C7yRiv5erHyJkoRuCLl8q",
    "item_id": "item_C7yRf7l29gNUytSg6YbtS",
    "content_index": 0,
    "transcript": "How are you?",
    "usage": {
        "type": "duration",
        "seconds": 2
    }
}

{
    "type": "output_audio_buffer.stopped",
    "event_id": "event_021fcf43ae6c4218",
    "response_id": "resp_C7yRg78p1IoKl2sQc77bC"
}

 */


/**
 * when a function is called
 * 
 * 
{
    "type": "response.output_item.added",
    "event_id": "event_C7zZ753YeAi9yJk1lct2S",
    "response_id": "resp_C7zZ7UHS6ddphtHcF8XCe",
    "output_index": 0,
    "item": {
        "id": "item_C7zZ7LZT29BjjwkrX5QSC",
        "object": "realtime.item",
        "type": "function_call",
        "status": "in_progress",
        "name": "navigate",
        "call_id": "call_GYucJlEAV3dygpzS",
        "arguments": ""
    }
}

{
    "type": "conversation.item.created",
    "event_id": "event_C7zZ7ra7jcLxlsUydb8s3",
    "previous_item_id": "item_C7zZ5lSeWZIzMHVIcH98J",
    "item": {
        "id": "item_C7zZ7LZT29BjjwkrX5QSC",
        "object": "realtime.item",
        "type": "function_call",
        "status": "in_progress",
        "name": "navigate",
        "call_id": "call_GYucJlEAV3dygpzS",
        "arguments": ""
    }
}

...

{
    "type": "response.output_item.added",
    "event_id": "event_C7zZ753YeAi9yJk1lct2S",
    "response_id": "resp_C7zZ7UHS6ddphtHcF8XCe",
    "output_index": 0,
    "item": {
        "id": "item_C7zZ7LZT29BjjwkrX5QSC",
        "object": "realtime.item",
        "type": "function_call",
        "status": "in_progress",
        "name": "navigate",
        "call_id": "call_GYucJlEAV3dygpzS",
        "arguments": ""
    }
}


{
    "type": "conversation.item.created",
    "event_id": "event_C7zZ7ra7jcLxlsUydb8s3",
    "previous_item_id": "item_C7zZ5lSeWZIzMHVIcH98J",
    "item": {
        "id": "item_C7zZ7LZT29BjjwkrX5QSC",
        "object": "realtime.item",
        "type": "function_call",
        "status": "in_progress",
        "name": "navigate",
        "call_id": "call_GYucJlEAV3dygpzS",
        "arguments": ""
    }
}



{
    "type": "response.function_call_arguments.delta",
    "event_id": "event_C7zZ7iaRFW94fLyjhSLMA",
    "response_id": "resp_C7zZ7UHS6ddphtHcF8XCe",
    "item_id": "item_C7zZ7LZT29BjjwkrX5QSC",
    "output_index": 0,
    "call_id": "call_GYucJlEAV3dygpzS",
    "delta": "{\"",
    "obfuscation": "k7dowsYWP8rv6w"
}
...
{
    "type": "response.function_call_arguments.delta",
    "event_id": "event_C7zZ7WfnwpmiTigRGe1a3",
    "response_id": "resp_C7zZ7UHS6ddphtHcF8XCe",
    "item_id": "item_C7zZ7LZT29BjjwkrX5QSC",
    "output_index": 0,
    "call_id": "call_GYucJlEAV3dygpzS",
    "delta": "\"}",
    "obfuscation": "4TdqsuD6iZoJfz"
}

{
    "type": "response.function_call_arguments.done",
    "event_id": "event_C7zZ8YUVkPtIRnnvDNFif",
    "response_id": "resp_C7zZ7UHS6ddphtHcF8XCe",
    "item_id": "item_C7zZ7LZT29BjjwkrX5QSC",
    "output_index": 0,
    "call_id": "call_GYucJlEAV3dygpzS",
    "name": "navigate",
    "arguments": "{\"page\":\"/about\"}"
}

{
    "type": "response.output_item.done",
    "event_id": "event_C7zZ8rEHCoVBvtDkOSbBp",
    "response_id": "resp_C7zZ7UHS6ddphtHcF8XCe",
    "output_index": 0,
    "item": {
        "id": "item_C7zZ7LZT29BjjwkrX5QSC",
        "object": "realtime.item",
        "type": "function_call",
        "status": "completed",
        "name": "navigate",
        "call_id": "call_GYucJlEAV3dygpzS",
        "arguments": "{\"page\":\"/about\"}"
    }
}


{
    "type": "response.done",
    "event_id": "event_C7zZ8dxFtT8I4ofeJypeg",
    "response": {
        "object": "realtime.response",
        "id": "resp_C7zZ7UHS6ddphtHcF8XCe",
        "status": "completed",
        "status_details": null,
        "output": [
            {
                "id": "item_C7zZ7LZT29BjjwkrX5QSC",
                "object": "realtime.item",
                "type": "function_call",
                "status": "completed",
                "name": "navigate",
                "call_id": "call_GYucJlEAV3dygpzS",
                "arguments": "{\"page\":\"/about\"}"
            }
        ],
        "conversation_id": "conv_C7zY4TxoqUFCQBSInBlJ0",
        "modalities": [
            "audio",
            "text"
        ],
        "voice": "alloy",
        "output_audio_format": "pcm16",
        "temperature": 0.8,
        "max_output_tokens": "inf",
        "usage": {
            "total_tokens": 248,
            "input_tokens": 233,
            "output_tokens": 15,
            "input_token_details": {
                "text_tokens": 162,
                "audio_tokens": 71,
                "image_tokens": 0,
                "cached_tokens": 192,
                "cached_tokens_details": {
                    "text_tokens": 128,
                    "audio_tokens": 64,
                    "image_tokens": 0
                }
            },
            "output_token_details": {
                "text_tokens": 15,
                "audio_tokens": 0
            }
        },
        "metadata": null
    }
}

{
    "type": "conversation.item.created",
    "event_id": "event_C7zZ8yldhUOLt3qtF2aL0",
    "previous_item_id": "item_C7zZ7LZT29BjjwkrX5QSC",
    "item": {
        "id": "item_C7zZ8LSOstBIJVybR7gga",
        "object": "realtime.item",
        "type": "function_call_output",
        "call_id": "call_GYucJlEAV3dygpzS",
        "output": "{\"response\":\"Tool call navigate executed successfully.\"}"
    }
}
 * 
 * 
 */