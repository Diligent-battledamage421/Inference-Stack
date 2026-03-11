"""
Text generation pipeline — AutoModelForCausalLM + TextIteratorStreamer.

Extracted from the original worker.py monolithic implementation.
Handles: SmolLM2-135M, SmolLM2-360M, and any CausalLM model.
"""

import time
import threading
import logging
from typing import Generator

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

from .base import BasePipeline, InferenceResult

logger = logging.getLogger(__name__)


class TextGenPipeline(BasePipeline):
    """Text generation using AutoModelForCausalLM."""

    def __init__(self, model_id: str, device: str, quantization: str = "fp16"):
        super().__init__(model_id, device, quantization)
        self.model = None
        self.tokenizer = None

    def load(self, model_path: str = "") -> dict:
        repo = model_path if model_path else self.model_id

        logger.info(f"[TextGen] Loading {self.model_id} from {repo} (quantization={self.quantization})")

        vram_before = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0

        self.tokenizer = AutoTokenizer.from_pretrained(repo, trust_remote_code=True)

        dtype = torch.float16 if self.quantization == "fp16" else torch.float32
        if self.quantization == "int8":
            self.model = AutoModelForCausalLM.from_pretrained(
                repo, load_in_8bit=True, device_map=self.device, trust_remote_code=True
            )
        elif self.quantization == "int4":
            self.model = AutoModelForCausalLM.from_pretrained(
                repo, load_in_4bit=True, device_map=self.device, trust_remote_code=True
            )
        else:
            self.model = AutoModelForCausalLM.from_pretrained(
                repo, torch_dtype=dtype, trust_remote_code=True
            ).to(self.device)

        self.model.eval()

        vram_after = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0
        self.vram_used_bytes = vram_after - vram_before
        self.max_context_length = getattr(self.model.config, "max_position_embeddings", 2048)
        self.vocab_size = getattr(self.model.config, "vocab_size", 0)

        logger.info(f"[TextGen] {self.model_id} loaded. VRAM: {self.vram_used_bytes / 1e6:.1f}MB")

        return self.get_capabilities()

    def infer(self, request: dict) -> Generator[InferenceResult, None, None]:
        params = request.get("params", {}) or {}
        max_tokens = params.get("max_tokens", 50)
        temperature = params.get("temperature", 1.0)
        top_p = params.get("top_p", 1.0)

        prompt = request.get("prompt", "")
        token_ids = request.get("token_ids", [])

        if token_ids:
            input_ids = torch.tensor([token_ids], dtype=torch.long).to(self.device)
        elif prompt:
            encoded = self.tokenizer(prompt, return_tensors="pt").to(self.device)
            input_ids = encoded["input_ids"]
        else:
            yield InferenceResult(is_complete=True, finish_reason="ERROR")
            return

        prompt_tokens = input_ids.shape[1]
        start_time = time.time()

        try:
            streamer = TextIteratorStreamer(self.tokenizer, skip_prompt=True, skip_special_tokens=True)
            generate_output = [None]

            def run_generate():
                generate_output[0] = self.model.generate(**generation_kwargs)

            generation_kwargs = {
                "input_ids": input_ids,
                "max_new_tokens": max_tokens,
                "temperature": max(temperature, 0.01),
                "top_p": top_p,
                "do_sample": temperature > 0,
                "streamer": streamer,
            }

            thread = threading.Thread(target=run_generate)
            thread.start()

            prefill_time_ms = None
            for text_chunk in streamer:
                if not text_chunk:
                    continue
                now = time.time()
                if prefill_time_ms is None:
                    prefill_time_ms = (now - start_time) * 1000

                yield InferenceResult(chunk_text=text_chunk, chunk_token_ids=[])

            thread.join()

            if generate_output[0] is not None:
                output_ids = generate_output[0][0]
                completion_tokens = len(output_ids) - prompt_tokens
            else:
                completion_tokens = 0

            total_time_ms = (time.time() - start_time) * 1000
            if prefill_time_ms is None:
                prefill_time_ms = total_time_ms
            decode_time_ms = total_time_ms - prefill_time_ms

            finish_reason = "MAX_TOKENS" if completion_tokens >= max_tokens else "STOP"

            yield InferenceResult(
                is_complete=True,
                finish_reason=finish_reason,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                prefill_time_ms=prefill_time_ms,
                decode_time_ms=decode_time_ms,
                total_time_ms=total_time_ms,
            )

        except Exception as e:
            logger.error(f"[TextGen] Inference error: {e}")
            yield InferenceResult(is_complete=True, finish_reason="ERROR")

    def unload(self):
        if self.model is not None:
            del self.model
            self.model = None
        if self.tokenizer is not None:
            del self.tokenizer
            self.tokenizer = None
        super().unload()

    def get_capabilities(self) -> dict:
        return {
            "max_context_length": self.max_context_length,
            "vocab_size": self.vocab_size,
            "supports_logprobs": False,
            "supports_json_mode": False,
            "supports_grammar": False,
            "model_type": "text_gen",
            "supports_image_input": False,
            "supports_image_output": False,
            "supports_audio_output": False,
            "supports_video_output": False,
        }
