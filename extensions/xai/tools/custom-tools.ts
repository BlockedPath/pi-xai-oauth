import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveXaiCredential } from "../auth";
import { DEFAULT_XAI_IMAGE_MODEL, DEFAULT_XAI_MODEL } from "../constants";
import {
  executeXaiImageEdit,
  ImageEditOperationError,
  validateXaiEditImageInput,
} from "../image-edit";
import {
  executeXaiImageToVideo,
  ImageToVideoOperationError,
  validateXaiImageToVideoInput,
} from "../image-to-video";
import {
  IMAGE_EDIT_MAX_PROMPT_CHARS,
  IMAGE_EDIT_MAX_REFERENCES,
  IMAGE_TO_VIDEO_MAX_PROMPT_CHARS,
} from "../media/constants";
import { normalizeXaiImageInput } from "../images";
import { defaultXaiRuntimeModelId, grokSupportsReasoningEffort, normalizedXaiModelId } from "../models";
import { createXaiResponse, postXaiJson } from "../responses";
import { resolveXaiRoute } from "../routing";
import { extractResponsesText, messageFromError, statusFromError } from "../text";
import { XAI_IMAGE_REFERENCE_SCHEMA, xaiTextInput, xaiToolError } from "./common";
import { activeXaiModel, isXaiNetworkToolActive, type XaiNetworkToolName } from "./model-scope";

function activeModelForXaiTool(pi: ExtensionAPI, ctx: any, toolName: XaiNetworkToolName) {
  if (!isXaiNetworkToolActive(pi, toolName)) return undefined;
  const model = activeXaiModel(ctx);
  return model;
}

function xaiToolDisabledError(toolName: XaiNetworkToolName, details: Record<string, unknown> = {}) {
  return xaiToolError(
    `Error: ${toolName} is disabled. Select an xAI/Grok model, run /xai-tools to enable ${toolName}, and request it explicitly. No xAI request was sent.`,
    { error: true, ...details },
  );
}

function invalidXaiImageInputError() {
  return xaiToolError(
    "Error: Invalid image input. Provide a valid image URL, data URL, or supported local workspace file. No xAI request was sent.",
    { error: true },
  );
}

/**
 * Register OAuth-backed custom xAI tools.
 *
 * Registrations deliberately omit constrainedSampling until the pinned OAuth
 * Responses route has route-specific strict-tool evidence (see ADR 0002).
 */
export function registerCustomXaiTools(pi: ExtensionAPI) {
    pi.registerTool({
      name: "xai_generate_text",
      label: "xAI Generate Text",
      description: "Opt-in text generation through a separate xAI API request. Enable via /xai-tools and call only when the user explicitly requests it.",
      promptGuidelines: ["Call xai_generate_text only when the user explicitly requests a separate xAI text-generation request."],
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt or question" },
          model: { type: "string", description: "Entitled OAuth model to use; defaults to the active xAI model" },
          reasoning_effort: {
            type: "string",
            enum: ["none", "low", "medium", "high"],
            description:
              "Reasoning effort. Defaults to high for grok-4.5 and medium for other models when omitted.",
          },
          response_format: { type: "string", description: "Set to 'json' for JSON output" },
          previous_response_id: { type: "string", description: "Continue conversation" },
          image_url: { type: "string", description: "Optional image URL for vision/multimodal input (supports image analysis)" },
        },
        required: ["prompt"],
      },
      execute: async (_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) => {
        const activeModel = activeModelForXaiTool(pi, ctx, "xai_generate_text");
        if (!activeModel) return xaiToolDisabledError("xai_generate_text", { prompt: params?.prompt });

        const model = params.model || activeModel.id || defaultXaiRuntimeModelId() || DEFAULT_XAI_MODEL;
        let imageUrl: string | undefined;
        try {
          const workspaceRoot = ctx?.cwd;
          imageUrl = normalizeXaiImageInput(
            params.image_url,
            typeof workspaceRoot === "string" && workspaceRoot.trim() ? workspaceRoot : "",
          );
        } catch {
          return invalidXaiImageInputError();
        }
        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { reasoning: "", response_id: "" });
        }
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

        const effort = params.reasoning_effort || (normalizedXaiModelId(model) === "grok-4.5" ? "high" : "medium");
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
          data = await createXaiResponse(credential, body, _signal);
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
      description: "Opt-in paid multi-agent web/X research using Grok. Enable via /xai-tools and call only when the user explicitly requests xAI research.",
      promptGuidelines: ["Call xai_multi_agent only when the user explicitly requests xAI multi-agent research."],
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
        if (!activeModelForXaiTool(pi, ctx, "xai_multi_agent")) {
          return xaiToolDisabledError("xai_multi_agent", { query: params?.query });
        }
        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { agents_used: 0, response_id: "" });
        }

        const requestedAgents = params.num_agents === 16 ? 16 : 4;
        const effort = params.reasoning_effort || (requestedAgents === 16 ? "high" : "medium");
        const agentsUsed = effort === "high" ? 16 : 4;
        const prompt = `You are leading a team of ${agentsUsed} researchers. Research: ${params.query}`;
        let data: any;
        try {
          data = await createXaiResponse(credential, {
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
      name: "xai_x_search",
      label: "xAI X Search",
      description: "Opt-in paid X search using Grok's native real-time search. Enable via /xai-tools and call only when the user explicitly requests xAI X search.",
      promptGuidelines: ["Call xai_x_search only when the user explicitly requests xAI X search."],
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
        const activeModel = activeModelForXaiTool(pi, ctx, "xai_x_search");
        if (!activeModel) return xaiToolDisabledError("xai_x_search", { query: params?.query });
        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
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
          data = await createXaiResponse(credential, {
            model: activeModel.id,
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
      description: "Opt-in execution through xAI's native code interpreter. Enable via /xai-tools and call only when the user explicitly requests it.",
      promptGuidelines: ["Call xai_code_execution only when the user explicitly requests xAI code execution."],
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "Python code to execute or analyze" } },
        required: ["code"],
      },
      execute: async (_toolCallId: string, params: { code?: string }, _signal: any, _onUpdate: any, ctx: any) => {
        const activeModel = activeModelForXaiTool(pi, ctx, "xai_code_execution");
        if (!activeModel) return xaiToolDisabledError("xai_code_execution", { code: params?.code });
        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { code: params?.code });
        }
        const prompt = `Execute this Python code and show the result or output:\n\n${params.code}`;
        let data: any;
        try {
          data = await createXaiResponse(credential, {
            model: activeModel.id,
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
      description: "Opt-in paid image generation through xAI. Enable via /xai-tools and call only when the user explicitly requests an image.",
      promptGuidelines: ["Call xai_generate_image only when the user explicitly asks to generate an image with xAI."],
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed description of the image to generate" },
          model: { type: "string", description: "Image model to use", default: DEFAULT_XAI_IMAGE_MODEL },
          n: { type: "number", minimum: 1, maximum: 4, description: "Number of images to generate (1-4)" }
        },
        required: ["prompt"],
      },
      execute: async (_toolCallId: string, params: { prompt?: string; model?: string; size?: string; n?: number }, _signal: any, _onUpdate: any, ctx: any) => {
        if (!activeModelForXaiTool(pi, ctx, "xai_generate_image")) {
          return xaiToolDisabledError("xai_generate_image", { prompt: params?.prompt });
        }
        if (params?.size !== undefined) {
          return xaiToolError("Error: The xAI image API does not support the 'size' parameter. Omit it from the request.", {
            error: true,
            prompt: params.prompt,
          });
        }
        if (params?.n !== undefined && (!Number.isInteger(params.n) || params.n < 1 || params.n > 4)) {
          return xaiToolError("Error: The 'n' parameter must be an integer from 1 to 4.", {
            error: true,
            prompt: params.prompt,
          });
        }

        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { prompt: params?.prompt });
        }
        const body: Record<string, any> = {
          model: params.model || DEFAULT_XAI_IMAGE_MODEL,
          prompt: params.prompt,
        };
        if (params.n !== undefined) {
          body.n = params.n;
        }

        let data: any;
        try {
          const route = resolveXaiRoute(credential.kind, "image-generation");
          data = await postXaiJson(credential.token, route.url, body, _signal);
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

    pi.registerTool({
      name: "xai_edit_image",
      label: "xAI Edit Image",
      description:
        "Opt-in paid image editing through xAI Imagine using bounded PNG/JPEG workspace files or data URLs. Enable via /xai-tools and call only when the user explicitly requests an edit.",
      promptGuidelines: [
        "Call xai_edit_image only when the user explicitly asks to edit or transform supplied images with xAI.",
        "Use only user-supplied workspace paths or PNG/JPEG data URLs; never invent paths or send remote URLs.",
      ],
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: IMAGE_EDIT_MAX_PROMPT_CHARS,
            description: "Description of the requested edit or transformation",
          },
          image: {
            type: "array",
            minItems: 1,
            maxItems: IMAGE_EDIT_MAX_REFERENCES,
            description: "One to three bounded local workspace or data-URL references",
            items: XAI_IMAGE_REFERENCE_SCHEMA,
          },
          aspect_ratio: {
            type: "string",
            enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto"],
            description: "Required for multiple references; omitted on the wire for one reference",
          },
        },
        required: ["prompt", "image"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) => {
        if (!activeModelForXaiTool(pi, ctx, "xai_edit_image")) {
          return xaiToolDisabledError("xai_edit_image");
        }

        let input;
        try {
          input = validateXaiEditImageInput(params);
        } catch (error) {
          const message = error instanceof ImageEditOperationError ? error.message : "Image edit input is invalid.";
          return xaiToolError(`Error: ${message}`, { error: true, code: "invalid_input" });
        }
        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", {
            error: true,
          });
        }

        try {
          const output = await executeXaiImageEdit({
            credential,
            input,
            workspaceRoot: ctx?.cwd,
            sessionManager: ctx?.sessionManager,
            signal,
          });
          return {
            content: [{
              type: "text",
              text: `Edited image saved to ${output.path} (${output.mimeType}, ${output.width}x${output.height}, ${output.byteLength} bytes).`,
            }],
            details: output,
          };
        } catch (error) {
          const operationError = error instanceof ImageEditOperationError ? error : undefined;
          return xaiToolError(
            `Error: ${operationError?.message ?? "xAI image edit failed safely."}`,
            {
              error: true,
              code: operationError?.code ?? "output_failure",
              ...(operationError?.status ? { status: operationError.status } : {}),
            },
          );
        }
      },
    } as any);

    pi.registerTool({
      name: "xai_image_to_video",
      label: "xAI Image to Video",
      description:
        "Opt-in high-cost image-to-video generation using one bounded PNG/JPEG workspace file or data URL. Enable via /xai-tools and call only when explicitly requested.",
      promptGuidelines: [
        "Call xai_image_to_video only when the user explicitly asks to animate or turn a supplied image into a video with xAI.",
        "Use only a user-supplied workspace path or strict PNG/JPEG data URL; never invent paths or use remote source URLs.",
        "Warn that generation may take up to five minutes and local cancellation does not cancel a submitted remote xAI job.",
      ],
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          image: XAI_IMAGE_REFERENCE_SCHEMA,
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: IMAGE_TO_VIDEO_MAX_PROMPT_CHARS,
            description: "Optional motion or animation guidance",
          },
          duration: { type: "number", enum: [6, 10], default: 6 },
          resolution: { type: "string", enum: ["480p", "720p"], default: "480p" },
        },
        required: ["image"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) => {
        if (!activeModelForXaiTool(pi, ctx, "xai_image_to_video")) {
          return xaiToolDisabledError("xai_image_to_video");
        }
        let input;
        try {
          input = validateXaiImageToVideoInput(params);
        } catch (error) {
          const message = error instanceof ImageToVideoOperationError
            ? error.message
            : "Image-to-video input is invalid.";
          return xaiToolError(`Error: ${message}`, { error: true, code: "invalid_input" });
        }
        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { error: true });
        }
        try {
          const output = await executeXaiImageToVideo({
            credential,
            input,
            workspaceRoot: ctx?.cwd,
            sessionManager: ctx?.sessionManager,
            signal,
          });
          return {
            content: [{
              type: "text",
              text: `Video saved to ${output.path} (${output.mimeType}, ${output.duration}s, ${output.resolution}, ${output.byteLength} bytes).`,
            }],
            details: output,
          };
        } catch (error) {
          const operationError = error instanceof ImageToVideoOperationError ? error : undefined;
          return xaiToolError(
            `Error: ${operationError?.message ?? "xAI image-to-video generation failed safely."}`,
            {
              error: true,
              code: operationError?.code ?? "output_failure",
              ...(operationError?.status ? { status: operationError.status } : {}),
            },
          );
        }
      },
    } as any);

    // ====================== NEW TOOLS (OAuth-only) ======================
    pi.registerTool({
      name: "xai_critique",
      label: "xAI Critique",
      description: "Opt-in critique through a separate high-reasoning xAI API request. Enable via /xai-tools and call only when explicitly requested.",
      promptGuidelines: ["Call xai_critique only when the user explicitly requests a separate xAI critique."],
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
        const activeModel = activeModelForXaiTool(pi, ctx, "xai_critique");
        if (!activeModel) return xaiToolDisabledError("xai_critique", { content: params?.content });
        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { content: params?.content });
        }
        const aspect = params.aspect || "overall quality and correctness";
        const tone = params.tone || "constructive";
        const prompt = `Provide a ${tone} critique focused on ${aspect}.\n\nContent to critique:\n${params.content}\n\nStructure your response with:\n- Strengths\n- Weaknesses / Issues\n- Specific suggestions for improvement\n- Overall assessment (score 1-10)\nUse step-by-step reasoning.`;
        let data: any;
        try {
          data = await createXaiResponse(credential, { model: activeModel.id, input: xaiTextInput(prompt), reasoning: { effort: "high" } }, _signal);
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
      description: "Opt-in image analysis through a separate xAI API request. Enable via /xai-tools and call only when explicitly requested.",
      promptGuidelines: ["Call xai_analyze_image only when the user explicitly requests xAI image analysis."],
      parameters: {
        type: "object",
        properties: {
          image: { type: "string", description: "Image URL, local file path, or base64 data URL" },
          question: { type: "string", description: "Question to ask about the image (default: describe in detail)" }
        },
        required: ["image"],
      },
      execute: async (_toolCallId: string, params: { image?: string; question?: string }, _signal: any, _onUpdate: any, ctx: any) => {
        const activeModel = activeModelForXaiTool(pi, ctx, "xai_analyze_image");
        if (!activeModel) return xaiToolDisabledError("xai_analyze_image");
        const question = params.question || "Describe this image in detail, including objects, text, style, and any notable details.";
        let imageInput: string | undefined;
        try {
          const workspaceRoot = ctx?.cwd;
          imageInput = normalizeXaiImageInput(
            params.image,
            typeof workspaceRoot === "string" && workspaceRoot.trim() ? workspaceRoot : "",
          );
        } catch {
          return invalidXaiImageInputError();
        }
        if (!imageInput) return invalidXaiImageInputError();
        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.");
        }
        const input = [{ role: "user", content: [{ type: "input_image", image_url: imageInput, detail: "high" }, { type: "input_text", text: question }] }];
        let data: any;
        try {
          data = await createXaiResponse(credential, { model: activeModel.id, input, reasoning: { effort: "medium" } }, _signal);
        } catch (error) {
          const status = statusFromError(error);
          return xaiToolError(`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`, { error: true, status });
        }
        const text = extractResponsesText(data) || "Image analysis completed.";
        return { content: [{ type: "text", text }], details: { image: params.image, question } };
      },
    } as any);

    pi.registerTool({
      name: "xai_deep_research",
      label: "xAI Deep Research",
      description: "Opt-in paid multi-step web/X research with Grok. Enable via /xai-tools and call only when the user explicitly requests xAI research.",
      promptGuidelines: ["Call xai_deep_research only when the user explicitly requests xAI deep research."],
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Research topic or question" },
          depth: { type: "string", description: "Research depth: low, medium, high", default: "high" }
        },
        required: ["topic"],
      },
      execute: async (_toolCallId: string, params: { topic?: string; depth?: string }, _signal: any, _onUpdate: any, ctx: any) => {
        const activeModel = activeModelForXaiTool(pi, ctx, "xai_deep_research");
        if (!activeModel) return xaiToolDisabledError("xai_deep_research", { topic: params?.topic });
        const credential = await resolveXaiCredential(ctx);
        if (!credential) {
          return xaiToolError("Error: No xAI OAuth credentials found. Please run the OAuth login first.", { topic: params?.topic });
        }
        const depth = params.depth || "high";
        const prompt = `Conduct deep ${depth} research on: ${params.topic}.\n\nSteps:\n1. Gather key facts, recent developments, and authoritative sources.\n2. Analyze different perspectives and potential biases.\n3. Synthesize findings into clear conclusions.\n4. Provide actionable insights and open questions.\n\nUse step-by-step reasoning and cite sources where possible.`;
        let data: any;
        try {
          data = await createXaiResponse(credential, {
            model: activeModel.id,
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
