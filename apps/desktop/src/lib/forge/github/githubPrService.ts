import { GitHubPrMonitor } from './githubPrMonitor';
import { DEFAULT_HEADERS } from './headers';
import { ghResponseToInstance, parseGitHubDetailedPullRequest } from './types';
import { sleep } from '$lib/utils/sleep';
import { writable } from 'svelte/store';
import type { PostHogWrapper } from '$lib/analytics/posthog';
import type { ForgePrService } from '$lib/forge/interface/forgePrService';
import type { RepoInfo } from '$lib/url/gitUrl';
import type {
	CreatePullRequestArgs,
	DetailedPullRequest,
	MergeMethod,
	PullRequest
} from '../interface/types';
import type { Octokit } from '@octokit/rest';

export class GitHubPrService implements ForgePrService {
	loading = writable(false);
	private readonly prMonitors = new Map<number, GitHubPrMonitor>();

	constructor(
		private octokit: Octokit,
		private repo: RepoInfo,
		private baseBranch: string,
		private posthog?: PostHogWrapper
	) {}

	async createPr({
		title,
		body,
		draft,
		baseBranchName,
		upstreamName
	}: CreatePullRequestArgs): Promise<PullRequest> {
		this.loading.set(true);
		const request = async () => {
			const resp = await this.octokit.rest.pulls.create({
				owner: this.repo.owner,
				repo: this.repo.name,
				head: upstreamName,
				base: baseBranchName,
				title,
				body,
				draft
			});

			return ghResponseToInstance(resp.data);
		};

		let attempts = 0;
		let lastError: any;
		let pr: PullRequest | undefined;

		// Use retries since request can fail right after branch push.
		while (attempts < 4) {
			try {
				pr = await request();
				this.posthog?.capture('PR Successful');
				return pr;
			} catch (err: any) {
				lastError = err;
				attempts++;
				await sleep(500);
			} finally {
				this.loading.set(false);
			}
		}
		throw lastError;
	}

	async get(prNumber: number): Promise<DetailedPullRequest> {
		const resp = await this.octokit.pulls.get({
			headers: DEFAULT_HEADERS,
			owner: this.repo.owner,
			repo: this.repo.name,
			pull_number: prNumber
		});
		return parseGitHubDetailedPullRequest(resp.data);
	}

	async merge(method: MergeMethod, prNumber: number) {
		await this.octokit.pulls.merge({
			owner: this.repo.owner,
			repo: this.repo.name,
			pull_number: prNumber,
			merge_method: method
		});
	}

	async reopen(prNumber: number) {
		await this.octokit.pulls.update({
			owner: this.repo.owner,
			repo: this.repo.name,
			pull_number: prNumber,
			state: 'open'
		});
	}

	prMonitor(prNumber: number): GitHubPrMonitor {
		let prMonitor = this.prMonitors.get(prNumber);
		if (prMonitor) {
			return prMonitor;
		}
		prMonitor = new GitHubPrMonitor(this, this.repo, prNumber, this.baseBranch);
		this.prMonitors.set(prNumber, prMonitor);
		return prMonitor;
	}

	async update(
		prNumber: number,
		details: { description?: string; state?: 'open' | 'closed'; targetBase?: string }
	) {
		const { description, state, targetBase } = details;
		await this.octokit.pulls.update({
			owner: this.repo.owner,
			repo: this.repo.name,
			pull_number: prNumber,
			body: description,
			state: state,
			base: targetBase
		});
	}
}
