import type { InterviewTranscriptSource } from "@nestor/contracts";

export function formatInterviewTranscriptSource(
  source: InterviewTranscriptSource,
): string {
  switch (source) {
    case "meeting_audio":
      return "System audio";
    case "microphone":
      return "Your microphone";
    case "meeting_native_transcript":
      return "Meeting transcript";
    case "typed_question":
      return "Typed question";
  }
}
