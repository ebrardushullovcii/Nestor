import type { JobPosting, ModelTokenUsage, ModelRequestAttempt, ModelRequestUsage } from '@nestor/contracts'
import type { AgentLoopToolDefinition, ModelTurnStreamEvent } from '@nestor/agent-runtime'
import type { AgentMessage, ToolCall } from '../types'

export type AgentExtractorPageType = 'search_results' | 'job_detail'

// Both collaborators are injected plain functions that never read `this`, so
// they are declared as function-typed properties rather than methods. The
// shapes are identical; the difference is that a caller may hold the function
// on its own — which every test double and every assertion about one does.
/**
 * Which work a model turn belongs to, so the provider can pick how hard it
 * thinks: search and source-check turns, form-filling turns, and fact checks
 * of written answers.
 */
export type BrowserAgentReasoningTask = 'search' | 'listing_screen' | 'page_read' | 'fit_batch' | 'apply' | 'claim_check'

export interface LLMClient {
  chatWithTools: (
    messages: AgentMessage[],
    tools: AgentLoopToolDefinition[],
    options?: {
      signal?: AbortSignal
      parallelToolCalls?: boolean
      onStreamEvent?: (event: ModelTurnStreamEvent) => void
      reasoningTask?: BrowserAgentReasoningTask
      /**
       * Which conversation this turn continues. A gateway that routes by it
       * keeps one conversation's turns on one upstream, whose prompt cache
       * then serves each turn's prefix (see model-request-identity).
       */
      conversationKey?: string
      includeUsage?: boolean
      onRequestAttempt?: (event: ModelRequestAttempt) => void
      onRequestUsage?: (usage: ModelRequestUsage) => void
      jsonOutput?: boolean
      jsonSchema?: { name: string; schema: Record<string, unknown> }
      /** The answer usually ends this work; see ChatWithToolsOptions.oneShot. */
      oneShot?: boolean
      /** Repeating text in the first user block, or the last message opening for oneShot. */
      stableLead?: string
      /** A later reusable block in the same conversation opening. */
      stableLeadEnd?: string
      /** Reusable user blocks in opening order, from least to most likely to change. */
      stableLeadBreakpoints?: readonly string[]
    }
  ) => Promise<{
    content?: string
    toolCalls?: ToolCall[]
    reasoning?: string
    finishReason?: string
    usage?: ModelTokenUsage
    /** Keep this conversation's earlier messages unedited (AgentLoopModel). */
    appendOnlyHistory?: boolean
  }>
}

/**
 * The same client with turns marked as belonging to `reasoningTask`, unless
 * the turn names its own (an answer check inside an application run).
 */
export function withReasoningTask(
  client: LLMClient,
  reasoningTask: BrowserAgentReasoningTask
): LLMClient {
  return {
    chatWithTools: (messages, tools, options) =>
      client.chatWithTools(messages, tools, {
        ...options,
        reasoningTask: options?.reasoningTask ?? reasoningTask,
      }),
  }
}

/** The same client with every turn marked as continuing one conversation. */
export function withConversationKey(
  client: LLMClient,
  conversationKey: string
): LLMClient {
  return {
    chatWithTools: (messages, tools, options) =>
      client.chatWithTools(messages, tools, {
        ...options,
        conversationKey: options?.conversationKey ?? conversationKey,
      }),
  }
}

export interface JobExtractor {
  extractJobsFromPage: (input: {
    excludedCanonicalUrls?: readonly string[]
    onStreamEvent?: (event: ModelTurnStreamEvent) => void
    pageText: string
    pageUrl: string
    pageType: AgentExtractorPageType
    maxJobs: number
    selectionContext?: string
    signal?: AbortSignal
  }) => Promise<Array<
    Pick<
      JobPosting,
      | 'sourceJobId'
      | 'canonicalUrl'
      | 'title'
      | 'company'
      | 'location'
      | 'description'
      | 'salaryText'
      | 'summary'
      | 'postedAt'
      | 'workMode'
      | 'applyPath'
      | 'easyApplyEligible'
      | 'keySkills'
    > & Partial<
      Pick<
        JobPosting,
        | 'applicationUrl'
        | 'postedAtText'
        | 'providerUpdatedAt'
        | 'responsibilities'
        | 'minimumQualifications'
        | 'preferredQualifications'
        | 'seniority'
        | 'employmentType'
        | 'department'
        | 'team'
        | 'employerWebsiteUrl'
        | 'employerDomain'
        | 'benefits'
        | 'searchRejection'
        | 'needsRenderedPage'
      >
    >
  >>
}
