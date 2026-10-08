import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface MiniMaxResponse {
  id?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  model?: string;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
  error?: {
    message?: string;
  };
}

interface MiniMaxStreamResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
  error?: {
    message?: string;
  };
}

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  async complete(prompt: string, history: AiChatMessage[]) {
    const apiKey = this.required('AI_API_KEY');
    const endpoint = this.resolveEndpoint(this.required('AI_API_URL'));
    const model = process.env.AI_MODEL?.trim() || 'MiniMax-M2.7';
    const maxCompletionTokens = this.numberSetting(
      'AI_MAX_COMPLETION_TOKENS',
      300,
      32,
      2048,
    );
    const temperature = this.numberSetting('AI_TEMPERATURE', 1, 0.01, 1);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: prompt },
            ...history.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          ],
          temperature,
          max_completion_tokens: maxCompletionTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `连接 MiniMax 对话服务失败：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      );
    } finally {
      clearTimeout(timeout);
    }

    const payload = (await response.json().catch(() => ({}))) as MiniMaxResponse;
    if (
      !response.ok ||
      (payload.base_resp?.status_code !== undefined &&
        payload.base_resp.status_code !== 0)
    ) {
      const message =
        payload.error?.message ||
        payload.base_resp?.status_msg ||
        `HTTP ${response.status}`;
      this.logger.error(
        `MiniMax failed status=${response.status} model=${model} requestId=${payload.id ?? 'unknown'} message=${message}`,
      );
      throw new BadGatewayException(`MiniMax 对话失败：${message}`);
    }

    const rawContent = payload.choices?.[0]?.message?.content?.trim() ?? '';
    const content = this.removeThinking(rawContent);
    if (!content) {
      throw new BadGatewayException('MiniMax 没有返回可播放的回复文字');
    }
    this.logger.log(
      `MiniMax reply ready model=${payload.model ?? model} chars=${content.length} requestId=${payload.id ?? 'unknown'}`,
    );
    return {
      content,
      model: payload.model ?? model,
      requestId: payload.id ?? null,
    };
  }

  async stream(
    prompt: string,
    history: AiChatMessage[],
    onDelta: (delta: string) => void,
    externalSignal?: AbortSignal,
  ) {
    const apiKey = this.required('AI_API_KEY');
    const endpoint = this.resolveEndpoint(this.required('AI_API_URL'));
    const model = process.env.AI_MODEL?.trim() || 'MiniMax-M2.7';
    const maxCompletionTokens = this.numberSetting(
      'AI_MAX_COMPLETION_TOKENS',
      300,
      32,
      2048,
    );
    const temperature = this.numberSetting('AI_TEMPERATURE', 1, 0.01, 1);

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: prompt },
            ...history.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          ],
          temperature,
          max_completion_tokens: maxCompletionTokens,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as MiniMaxResponse;
        const message =
          payload.error?.message ||
          payload.base_resp?.status_msg ||
          `HTTP ${response.status}`;
        throw new BadGatewayException(`MiniMax 对话失败：${message}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const thinkingFilter = new StreamingThinkingFilter();
      let buffer = '';
      let content = '';
      let requestId: string | null = null;
      let responseModel = model;

      const consumeLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;

        const payload = JSON.parse(data) as MiniMaxStreamResponse;
        if (
          payload.base_resp?.status_code !== undefined &&
          payload.base_resp.status_code !== 0
        ) {
          throw new BadGatewayException(
            `MiniMax 对话失败：${payload.base_resp.status_msg || payload.base_resp.status_code}`,
          );
        }
        if (payload.error?.message) {
          throw new BadGatewayException(`MiniMax 对话失败：${payload.error.message}`);
        }
        requestId = payload.id ?? requestId;
        responseModel = payload.model ?? responseModel;
        const rawDelta = payload.choices?.[0]?.delta?.content ?? '';
        if (!rawDelta) return;
        const delta = thinkingFilter.push(rawDelta);
        if (!delta) return;
        content += delta;
        onDelta(delta);
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
        if (done) break;
      }
      if (buffer.trim()) consumeLine(buffer);
      const tail = thinkingFilter.flush();
      if (tail) {
        content += tail;
        onDelta(tail);
      }

      content = content.trim();
      if (!content) {
        throw new BadGatewayException('MiniMax 没有返回可显示的回复文字');
      }
      this.logger.log(
        `MiniMax stream ready model=${responseModel} chars=${content.length} requestId=${requestId ?? 'unknown'}`,
      );
      return { content, model: responseModel, requestId };
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      if (externalSignal?.aborted) {
        throw new ServiceUnavailableException('对话流已取消');
      }
      throw new ServiceUnavailableException(
        `连接 MiniMax 流式对话服务失败：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private resolveEndpoint(baseUrl: string) {
    const normalized = baseUrl.replace(/\/+$/, '');
    if (
      normalized.endsWith('/chat/completions') ||
      normalized.endsWith('/text/chatcompletion_v2')
    ) {
      return normalized;
    }
    return `${normalized}/chat/completions`;
  }

  private removeThinking(content: string) {
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  private numberSetting(name: string, fallback: number, min: number, max: number) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new ServiceUnavailableException(`${name} 配置无效`);
    }
    return value;
  }

  private required(name: string) {
    const value = process.env[name]?.trim();
    if (!value) {
      throw new ServiceUnavailableException(`尚未配置 ${name}`);
    }
    return value;
  }
}

class StreamingThinkingFilter {
  private readonly openTag = '<think>';
  private readonly closeTag = '</think>';
  private pending = '';
  private insideThinking = false;

  push(chunk: string) {
    this.pending += chunk;
    let output = '';
    while (this.pending) {
      const tag = this.insideThinking ? this.closeTag : this.openTag;
      const tagIndex = this.pending.toLowerCase().indexOf(tag);
      if (tagIndex >= 0) {
        if (!this.insideThinking) output += this.pending.slice(0, tagIndex);
        this.pending = this.pending.slice(tagIndex + tag.length);
        this.insideThinking = !this.insideThinking;
        continue;
      }

      const keep = this.partialTagSuffixLength(this.pending.toLowerCase(), tag);
      const readyLength = this.pending.length - keep;
      if (!this.insideThinking) output += this.pending.slice(0, readyLength);
      this.pending = this.pending.slice(readyLength);
      break;
    }
    return output;
  }

  flush() {
    const output = this.insideThinking ? '' : this.pending;
    this.pending = '';
    return output;
  }

  private partialTagSuffixLength(value: string, tag: string) {
    const maxLength = Math.min(value.length, tag.length - 1);
    for (let length = maxLength; length > 0; length -= 1) {
      if (tag.startsWith(value.slice(-length))) return length;
    }
    return 0;
  }
}
