export function openAIInput(input, screenshot) {
  if (!screenshot?.dataUrl) return input;
  return [{
    role: "user",
    content: [
      { type: "input_text", text: input },
      { type: "input_image", image_url: screenshot.dataUrl }
    ]
  }];
}

export function claudeContent(input, screenshot) {
  const content = [{ type: "text", text: input }];
  const image = parseDataUrl(screenshot?.dataUrl);
  if (image) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: screenshot.mediaType || image.mediaType,
        data: image.base64
      }
    });
  }
  return content;
}

export function ollamaMessages(provider, instructions, input) {
  if (provider === "deepseek_r1_ollama") {
    return [{ role: "user", content: `${instructions}\n\n${input}` }];
  }
  return [
    { role: "system", content: instructions },
    { role: "user", content: input }
  ];
}

export function stripReasoningTags(value) {
  return String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { mediaType: match[1], base64: match[2] } : null;
}
