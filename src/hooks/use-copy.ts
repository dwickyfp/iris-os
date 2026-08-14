"use client";

import { useState } from "react";

export const useCopy = (timeout = 2000) => {
  const [copied, setCopied] = useState(false);

  const copy = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) return false;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), timeout);
      return true;
    } catch {
      return false;
    }
  };

  return { copied, copy };
};
