import type { JobPosting } from '@nestor/contracts'
import type { AgentLoopToolDefinition } from '@nestor/agent-runtime'
import type { AgentMessage, ToolCall } from '../types'

export type AgentExtractorPageType = 'search_results' | 'job_detail'

// Both collaborators are injected plain functions that never read `this`, so
// they are declared as function-typed properties rather than methods. The
// shapes are identical; the difference is that a caller may hold the function
// on its own — which every test double and every assertion about one does.
export interface LLMClient {
  chatWithTools: (
    messages: AgentMessage[],
    tools: AgentLoopToolDefinition[],
    options?: {
      signal?: AbortSignal
      parallelToolCalls?: boolean
      maxOutputTokens?: number
    }
  ) => Promise<{
    content?: string
    toolCalls?: ToolCall[]
    reasoning?: string
  }>
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
      >
    >
  >>
}
