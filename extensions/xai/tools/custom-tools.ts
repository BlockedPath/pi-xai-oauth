import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveXaiAuthToken } from "../auth";
import { DEFAULT_XAI_IMAGE_MODEL, DEFAULT_XAI_MODEL, XAI_IMAGES_GENERATIONS_URL } from "../constants";
import { normalizeXaiImageInput } from "../images";
import { grokSupportsReasoningEffort } from "../models";
import { createXaiResponse, postXaiJson } from "../responses";
import { extractResponsesText, messageFromError, statusFromError } from "../text";
import { xaiTextInput, xaiToolError } from "./common";

/** Register OAuth-backed custom xAI tools. */
export function registerCustomXaiTools(pi: ExtensionAPI) {
    pi.registerTool({
      name: "xai_generate_text",
      label: "xAI Generate Text",
      description: "Generate text using Grok with full reasoning, structured output, and stateful conversations.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt or question" },
          model: { type: "string", description: "Model to use", default: DEFAULT_XAI_MODEL },
          reasoning_effort: { type: "string", enum: ["none", "low", "medium", "high"], default: "medium" },
          response_format: { type: "string", description: "Set to 'json' for JSON output" },
          previous_response_id: { type: "string", description: "Continue conversation" },
          image_url: { type: "string", description: "Optional image URL for vision/multimodal input (supports image analysis)" },
        },
        required: ["prompt"],
      },
      execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { reasoning: "", response_id: "" });
        }

        const model = params.model || DEFAULT_XAI_MODEL;
        const imageUrl = normalizeXaiImageInput(params.image_url);
        const input = imageUrl
          ? [
              {
                role: "user",
                content: [
                  { type: "input_text", text: params.prompt || "Describe this image." },
                  { type: "input_image", image_url: imageUrl, detail: "high" },
                ],
              },
            ]
          : params.prompt;

        const body: any = {
          model,
          input,
        };

        const effort = params.reasoning_effort || "medium";
        if (grokSupportsReasoningEffort(model) && effort !== "none") {
          body.reasoning = { effort };
        }

        if (params.response_format === "json") {
          body.text = { format: { type: "json_object" } };
        }
        if (params.previous_response_id) {
          body.previous_response_id = params.previous_response_id;
        }

        let data: any;
        try {
          data = await createXaiResponse(apiKey, body, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, {
            error: true,
            status,
            reasoning: "",
            response_id: "",
          });
        }
        const text = extractResponsesText(data);

        return {
          content: [{ type: "text", text }],
          details: {
            reasoning: data.reasoning?.content?.[0]?.text || "",
            response_id: data.id,
          },
        };
      },
    } as any);

    pi.registerTool({
      name: "xai_multi_agent",
      label: "xAI Multi-Agent Research",
      description: "Run deep multi-agent research using Grok.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Research topic" },
          num_agents: { type: "number", enum: [4, 16], default: 4 },
          reasoning_effort: { type: "string", enum: ["medium", "high"], description: "Override num_agents: medium uses 4 agents, high uses 16 agents" },
        },
        required: ["query"],
      },
      execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { agents_used: 0, response_id: "" });
        }

        const requestedAgents = params.num_agents === 16 ? 16 : 4;
        const effort = params.reasoning_effort || (requestedAgents === 16 ? "high" : "medium");
        const agentsUsed = effort === "high" ? 16 : 4;
        const prompt = `You are leading a team of ${agentsUsed} researchers. Research: ${params.query}`;
        let data: any;
        try {
          data = await createXaiResponse(apiKey, {
            model: "grok-4.20-multi-agent-0309",
            input: xaiTextInput(prompt),
            reasoning: { effort },
            tools: [{ type: "web_search" }, { type: "x_search" }],
          }, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, {
            error: true,
            status,
            agents_used: 0,
            response_id: "",
          });
        }
        const text = extractResponsesText(data) || "Research completed";

        return {
          content: [{ type: "text", text }],
          details: {
            agents_used: agentsUsed,
            response_id: data.id,
          },
        };
      },
    } as any);

    // Agentic tools that leverage xAI's native server-side tools.
    pi.registerTool({
      name: "xai_web_search",
      label: "xAI Web Search",
      description: "Search the web using Grok's native web knowledge and search capabilities.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
      execute: async (_toolCallId: string, params: { query?: string }, _signal: any, _onUpdate: any, ctx: any) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { query: params?.query });
        }
        const prompt = `Search the web for: ${params.query}. Summarize the top results with sources, key facts, dates, and recent developments. Prioritize authoritative sources.`;
        let data: any;
        try {
          data = await createXaiResponse(apiKey, {
            model: DEFAULT_XAI_MODEL,
            input: xaiTextInput(prompt),
            reasoning: { effort: "medium" },
            tools: [{ type: "web_search", enable_image_understanding: true }],
          }, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, { error: true, status, query: params.query });
        }
        const text = extractResponsesText(data) || `No results for: ${params.query}`;
        return { content: [{ type: "text", text }], details: { query: params.query } };
      },
    } as any);

    pi.registerTool({
      name: "xai_x_search",
      label: "xAI X Search",
      description: "Search X (Twitter) using Grok's native real-time X search and knowledge. Supports advanced filters like count, since, until.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "X search query" },
          count: { type: "number", description: "Max number of posts to return (1-10)", default: 5 },
          since: { type: "string", description: "Only posts after this date (YYYY-MM-DD)" },
          until: { type: "string", description: "Only posts before this date (YYYY-MM-DD)" }
        },
        required: ["query"],
      },
      execute: async (_toolCallId: string, params: { query?: string; count?: number; since?: string; until?: string }, _signal: any, _onUpdate: any, ctx: any) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { query: params?.query });
        }
        let prompt = `You have native real-time access to X (Twitter) posts and trends via Grok's built-in X search. Use it to find the most relevant recent posts about: ${params.query}.

Filters:`;
        if (params.count) prompt += ` Return up to ${params.count} posts.`;
        if (params.since) prompt += ` Only posts since ${params.since}.`;
        if (params.until) prompt += ` Only posts until ${params.until}.`;
        prompt += `

Summarize:
- Top posts with usernames, engagement (likes/reposts/views), and timestamps
- Key quotes or main points from influential tweets
- Overall sentiment and any emerging trends or threads
- Notable users or conversations

Be specific and cite examples where helpful.`;
        const xSearchTool: Record<string, any> = { type: "x_search", enable_image_understanding: true };
        if (params.since) xSearchTool.from_date = params.since;
        if (params.until) xSearchTool.to_date = params.until;
        let data: any;
        try {
          data = await createXaiResponse(apiKey, {
            model: DEFAULT_XAI_MODEL,
            input: xaiTextInput(prompt),
            reasoning: { effort: "medium" },
            tools: [xSearchTool],
          }, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, { error: true, status, query: params.query });
        }
        const text = extractResponsesText(data) || `No X results for: ${params.query}`;
        return { content: [{ type: "text", text }], details: { query: params.query } };
      },
    } as any);

    pi.registerTool({
      name: "xai_code_execution",
      label: "xAI Code Execution",
      description: "Execute or analyze Python code using xAI's native code interpreter tool.",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "Python code to execute or analyze" } },
        required: ["code"],
      },
      execute: async (_toolCallId: string, params: { code?: string }, _signal: any, _onUpdate: any, ctx: any) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { code: params?.code });
        }
        const prompt = `Execute this Python code and show the result or output:\n\n${params.code}`;
        let data: any;
        try {
          data = await createXaiResponse(apiKey, {
            model: DEFAULT_XAI_MODEL,
            input: xaiTextInput(prompt),
            reasoning: { effort: "low" },
            tools: [{ type: "code_interpreter" }],
          }, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, { error: true, status, code: params.code });
        }
        const text = extractResponsesText(data) || `Executed: ${String(params.code).substring(0, 100)}...`;
        return { content: [{ type: "text", text }], details: { code: params.code } };
      },
    } as any);

    // ====================== ADDITIONAL TOOLS ======================
    pi.registerTool({
      name: "xai_generate_image",
      label: "xAI Image Generation",
      description: "Generate images using xAI's current image generation model.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed description of the image to generate" },
          model: { type: "string", description: "Image model to use", default: DEFAULT_XAI_IMAGE_MODEL },
          n: { type: "number", description: "Number of images to generate (1-4)", default: 1 }
        },
        required: ["prompt"],
      },
      execute: async (_toolCallId: string, params: { prompt?: string; model?: string; n?: number }, _signal: any, _onUpdate: any, ctx: any) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { prompt: params?.prompt });
        }
        let data: any;
        try {
          data = await postXaiJson(apiKey, XAI_IMAGES_GENERATIONS_URL, {
            model: params.model || DEFAULT_XAI_IMAGE_MODEL,
            prompt: params.prompt,
            n: params.n || 1
          }, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI Image API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, { error: true, status, prompt: params.prompt });
        }
        const images = data.data || [];
        const urls = images.map((img: any) => img.url).filter(Boolean);
        const text = urls.length > 0 
          ? `Generated ${urls.length} image(s):\n${urls.map((u: string) => `- ${u}`).join("\n")}` 
          : "Image generation completed but no URLs returned.";
        return { content: [{ type: "text", text }], details: { prompt: params.prompt, urls, count: urls.length } };
      },
    } as any);

    // ====================== NEW TOOLS (OAuth-only) ======================
    pi.registerTool({
      name: "xai_critique",
      label: "xAI Critique",
      description: "Provide detailed, reasoned critique of code, designs, writing, ideas, or arguments with structured feedback.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The code, text, design, or idea to critique" },
          aspect: { type: "string", description: "Focus area: code, design, writing, logic, security, performance, etc." },
          tone: { type: "string", description: "Tone of critique: constructive, strict, balanced", default: "constructive" }
        },
        required: ["content"],
      },
      execute: async (_toolCallId: string, params: { content?: string; aspect?: string; tone?: string }, _signal: any, _onUpdate: any, ctx: any) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { content: params?.content });
        }
        const aspect = params.aspect || "overall quality and correctness";
        const tone = params.tone || "constructive";
        const prompt = `Provide a ${tone} critique focused on ${aspect}.\n\nContent to critique:\n${params.content}\n\nStructure your response with:\n- Strengths\n- Weaknesses / Issues\n- Specific suggestions for improvement\n- Overall assessment (score 1-10)\nUse step-by-step reasoning.`;
        let data: any;
        try {
          data = await createXaiResponse(apiKey, { model: DEFAULT_XAI_MODEL, input: xaiTextInput(prompt), reasoning: { effort: "high" } }, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, { error: true, status });
        }
        const text = extractResponsesText(data) || "Critique completed.";
        return { content: [{ type: "text", text }], details: { aspect, tone } };
      },
    } as any);

    pi.registerTool({
      name: "xai_analyze_image",
      label: "xAI Image Analysis",
      description: "Analyze images, describe visual content, answer questions about images, or extract information using Grok's vision capabilities.",
      parameters: {
        type: "object",
        properties: {
          image: { type: "string", description: "Image URL, local file path, or base64 data URL" },
          question: { type: "string", description: "Question to ask about the image (default: describe in detail)" }
        },
        required: ["image"],
      },
      execute: async (_toolCallId: string, params: { image?: string; question?: string }, _signal: any, _onUpdate: any, ctx: any) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { image: params?.image });
        }
        const question = params.question || "Describe this image in detail, including objects, text, style, and any notable details.";
        const imageInput = normalizeXaiImageInput(params.image) || params.image;
        const input = [{ role: "user", content: [{ type: "input_image", image_url: imageInput, detail: "high" }, { type: "input_text", text: question }] }];
        let data: any;
        try {
          data = await createXaiResponse(apiKey, { model: DEFAULT_XAI_MODEL, input, reasoning: { effort: "medium" } }, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, { error: true, status, image: params.image });
        }
        const text = extractResponsesText(data) || "Image analysis completed.";
        return { content: [{ type: "text", text }], details: { image: params.image, question } };
      },
    } as any);

    pi.registerTool({
      name: "xai_deep_research",
      label: "xAI Deep Research",
      description: "Conduct thorough multi-step research on a topic, synthesize information, cite sources, and provide comprehensive analysis with high reasoning effort.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Research topic or question" },
          depth: { type: "string", description: "Research depth: low, medium, high", default: "high" }
        },
        required: ["topic"],
      },
      execute: async (_toolCallId: string, params: { topic?: string; depth?: string }, _signal: any, _onUpdate: any, ctx: any) => {
        const apiKey = await resolveXaiAuthToken(ctx);
        if (!apiKey) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { topic: params?.topic });
        }
        const depth = params.depth || "high";
        const prompt = `Conduct deep ${depth} research on: ${params.topic}.\n\nSteps:\n1. Gather key facts, recent developments, and authoritative sources.\n2. Analyze different perspectives and potential biases.\n3. Synthesize findings into clear conclusions.\n4. Provide actionable insights and open questions.\n\nUse step-by-step reasoning and cite sources where possible.`;
        let data: any;
        try {
          data = await createXaiResponse(apiKey, {
            model: DEFAULT_XAI_MODEL,
            input: xaiTextInput(prompt),
            reasoning: { effort: depth === "high" ? "high" : "medium" },
            tools: [{ type: "web_search" }, { type: "x_search" }],
          }, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, { error: true, status });
        }
        const text = extractResponsesText(data) || "Research completed.";
        return { content: [{ type: "text", text }], details: { topic: params.topic, depth } };
      },
    } as any);
}
