/**
 * Roadmap logic — pure, browser-safe, no IO.
 *
 * The roadmap is a dependency graph of topics (each lists the topics that must
 * be mastered first). Sequencing is BY DEPENDENCY, never by calendar: the next
 * topic is the first one — in roadmap order — that is not mastered yet and
 * whose prerequisites are all mastered. Mastery is the only thing that opens
 * a topic's dependents ("shaky" does not).
 */

import type { ProgressDoc, RoadmapDoc, RoadmapTopic, TopicStatus } from "./contracts/roadmap.ts";

/** Everything wrong with a topic list, as sentences for the learner (empty =
 *  valid): blank/duplicate ids, a prerequisite that doesn't exist, a topic
 *  that requires itself, and dependency cycles. */
export function roadmapProblems(topics: readonly RoadmapTopic[]): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	for (const topic of topics) {
		if (typeof topic.id !== "string" || topic.id.trim() === "") {
			problems.push("A topic has no id.");
			continue;
		}
		if (ids.has(topic.id)) problems.push(`Two topics share the id "${topic.id}".`);
		ids.add(topic.id);
		if (typeof topic.title !== "string" || topic.title.trim() === "") problems.push(`Topic "${topic.id}" has no title.`);
	}
	for (const topic of topics) {
		for (const prereq of topic.prereqs) {
			if (prereq === topic.id) problems.push(`Topic "${topic.id}" lists itself as a prerequisite.`);
			else if (!ids.has(prereq)) problems.push(`Topic "${topic.id}" needs "${prereq}", which is not in the roadmap.`);
		}
	}
	if (problems.length === 0) {
		const reachable = new Set(topologicalOrder(topics).map((t) => t.id));
		const loop = topics.filter((t) => !reachable.has(t.id)).map((t) => t.id);
		if (loop.length > 0) problems.push(`The prerequisites form a loop through: ${loop.join(", ")}.`);
	}
	return problems;
}

/** Topics in an order where every prerequisite comes before its dependents,
 *  ties broken by the roadmap's own order. Topics caught in a cycle (or
 *  pointing at unknown prerequisites) are left out — roadmapProblems names them. */
export function topologicalOrder(topics: readonly RoadmapTopic[]): RoadmapTopic[] {
	const byId = new Map(topics.map((t) => [t.id, t]));
	const position = new Map(topics.map((t, i) => [t.id, i]));
	const waiting = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const topic of topics) {
		const prereqs = [...new Set(topic.prereqs)].filter((p) => byId.has(p) && p !== topic.id);
		waiting.set(topic.id, prereqs.length);
		for (const prereq of prereqs) dependents.set(prereq, [...(dependents.get(prereq) ?? []), topic.id]);
	}
	const ready = topics.filter((t) => waiting.get(t.id) === 0).map((t) => t.id);
	const order: RoadmapTopic[] = [];
	while (ready.length > 0) {
		ready.sort((a, b) => position.get(a)! - position.get(b)!);
		const id = ready.shift()!;
		order.push(byId.get(id)!);
		for (const next of dependents.get(id) ?? []) {
			const left = waiting.get(next)! - 1;
			waiting.set(next, left);
			if (left === 0) ready.push(next);
		}
	}
	return order;
}

export function statusOf(progress: ProgressDoc | null | undefined, topicId: string): TopicStatus {
	return progress?.topics[topicId]?.status ?? "not_started";
}

/** True when every prerequisite of `topic` is mastered. */
export function prerequisitesMet(topic: RoadmapTopic, progress: ProgressDoc | null | undefined): boolean {
	return topic.prereqs.every((p) => statusOf(progress, p) === "mastered");
}

/** The topic to learn next, or null when everything is mastered (or the
 *  roadmap is empty/invalid so nothing can open). */
export function nextTopic(roadmap: RoadmapDoc, progress: ProgressDoc | null | undefined): RoadmapTopic | null {
	for (const topic of topologicalOrder(roadmap.topics)) {
		if (statusOf(progress, topic.id) === "mastered") continue;
		if (prerequisitesMet(topic, progress)) return topic;
	}
	return null;
}

export interface RoadmapCounts {
	total: number;
	mastered: number;
	learning: number;
	shaky: number;
	notStarted: number;
}

export function roadmapCounts(roadmap: RoadmapDoc, progress: ProgressDoc | null | undefined): RoadmapCounts {
	const counts: RoadmapCounts = { total: roadmap.topics.length, mastered: 0, learning: 0, shaky: 0, notStarted: 0 };
	for (const topic of roadmap.topics) {
		const status = statusOf(progress, topic.id);
		if (status === "mastered") counts.mastered++;
		else if (status === "learning") counts.learning++;
		else if (status === "shaky") counts.shaky++;
		else counts.notStarted++;
	}
	return counts;
}
