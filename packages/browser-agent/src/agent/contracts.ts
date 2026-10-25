import type { JobPosting, ModelTokenUsage } from '@nestor/contracts'
import type { AgentLoopToolDefinition } from '@nestor/agent-runtime'
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
export type BrowserAgentReasoningTask = 'search' | 'apply' | 'claim_check'

export interface LLMClient {
  chatWithTools: (
    messages: AgentMessage[],
    tools: AgentLoopToolDefinition[],
    options?: {
      signal?: AbortSignal
      parallelToolCalls?: boolean
      maxOutputTokens?: number
      reasoningTask?: BrowserAgentReasoningTask
      includeUsage?: boolean
    }
  ) => Promise<{
    content?: string
    toolCalls?: ToolCall[]
    reasoning?: string
    usage?: ModelTokenUsage
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

export interface JobExtractor {
  extractJobsFromPage: (input: {
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
      >
    >
  >>
}
