# Native Pixel model baseline

No Gemini Nano tok/s has been measured. AICore is installed on the Pixel 8 Pro, but that does not prove model/API availability or accelerator placement.

Root checked the current official [ML Kit device list](https://developers.google.com/ml-kit/genai): Pixel 8 Pro is absent. The [AICore Developer Preview](https://developers.google.com/ml-kit/genai/aicore-dev-preview) requires the same Prompt-supported devices, so it does not document a Pixel 8 route either. We have not found a supported public benchmark route for this handset; this is not proof that built-in Google features cannot run Nano.

The [Prompt API guide](https://developers.google.com/ml-kit/genai/prompt/android/get-started) does document countTokens and maxOutputTokens. Output re-tokenization must not be assumed identical to the model's actual generated-token count without verifying the API contract. No native benchmark harness has been installed and no account/preview enrollment or phone settings were changed.

A different native model's latency and quality would be a useful user-facing comparison, but would not isolate Shielded overhead or constitute a same-model runtime comparison. Nano testing can be revisited on the supported Pixel 10.
