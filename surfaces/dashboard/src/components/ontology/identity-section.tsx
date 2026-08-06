import { useCallback, useEffect, useState } from "react";
import {
	ALIAS_KINDS,
	archiveEntityAlias,
	getEntityAliases,
	getWhatTouched,
	linkEntityAlias,
	proposeManualMerge,
	type EntityAliasRecord,
	type WhatTouchedResult,
} from "@/lib/ontology-api";
import { groupTouchedBySource, touchedTitle } from "./identity-panel-data";

/**
 * Identity for the entity the drawer already has open. Two reads: every active
 * handle with the source that asserted it, then `what_touched` for the same
 * entity grouped by source.
 *
 * The entity **id** is what goes to the daemon, never the display name —
 * resolution folds every alias in either direction, and an id cannot be
 * ambiguous the way a spelling can.
 */
export function IdentitySection({
	agentId,
	entityId,
	entityName,
	onQueuedMerge,
}: {
	agentId: string;
	entityId: string;
	entityName: string;
	/** A merge queued here lands in the review queue, which may already be open. */
	onQueuedMerge?: () => void;
}) {
	const [aliases, setAliases] = useState<EntityAliasRecord[]>([]);
	const [touched, setTouched] = useState<WhatTouchedResult | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [alias, setAlias] = useState("");
	const [aliasKind, setAliasKind] = useState<string>(ALIAS_KINDS[0]);
	const [linkError, setLinkError] = useState<string | null>(null);
	const [linking, setLinking] = useState(false);
	const [mergeSource, setMergeSource] = useState("");
	const [mergeNote, setMergeNote] = useState<string | null>(null);
	const [merging, setMerging] = useState(false);

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const [nextAliases, nextTouched] = await Promise.all([
				getEntityAliases(agentId, entityId),
				getWhatTouched(agentId, entityId, 40),
			]);
			setAliases(nextAliases);
			setTouched(nextTouched);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : "Identity unavailable");
		}
	}, [agentId, entityId]);

	useEffect(() => {
		void load();
	}, [load]);

	const link = async () => {
		const value = alias.trim();
		if (!value) return;
		setLinking(true);
		setLinkError(null);
		const result = await linkEntityAlias(agentId, entityId, { alias: value, aliasKind });
		setLinking(false);
		if (!result.ok) {
			// A 409 names the entity that already holds the handle. That name is
			// the operator's next move, so it is shown as the daemon wrote it.
			setLinkError(result.error);
			return;
		}
		setAlias("");
		await load();
	};

	const unlink = async (aliasId: string) => {
		const result = await archiveEntityAlias(agentId, entityId, aliasId);
		if (!result.ok) {
			setLinkError(result.error);
			return;
		}
		await load();
	};

	const queueMerge = async () => {
		const source = mergeSource.trim();
		if (!source) return;
		setMerging(true);
		setMergeNote(null);
		const result = await proposeManualMerge(agentId, entityId, source);
		setMerging(false);
		setMergeNote(result.ok ? "Queued for review." : (result.error ?? "Merge failed"));
		if (result.ok) {
			setMergeSource("");
			onQueuedMerge?.();
		}
	};

	const groups = groupTouchedBySource(touched?.items ?? []);

	return (
		<section className="id-sec">
			<div className="gr-section-label">Identity</div>
			{loadError && <p className="oi-note oi-note--bad">{loadError}</p>}

			{touched && (
				<p className="id-resolved">
					resolves via <b>{touched.identity.matchedVia}</b> to {touched.identity.entityIds.length} row
					{touched.identity.entityIds.length === 1 ? "" : "s"}
					{touched.identity.names.length > 0 && <> · {touched.identity.names.join(" | ")}</>}
				</p>
			)}

			{/* Handles */}
			<ul className="id-alias-list">
				{aliases.length === 0 && <li className="id-empty">No handles recorded for {entityName}.</li>}
				{aliases.map((row) => (
					<li key={row.id} className="id-alias">
						<div className="min-w-0 flex-1">
							<div className="id-alias-name">{row.alias}</div>
							<div className="id-alias-meta">
								{row.aliasKind ?? "unspecified"}
								{row.source && <> · {row.source}</>}
							</div>
						</div>
						<button
							type="button"
							className="oi-btn"
							onClick={() => void unlink(row.id)}
							aria-label={`Unlink ${row.alias}`}
						>
							Unlink
						</button>
					</li>
				))}
			</ul>

			{/* Link a handle — applies directly; additive and reversible. */}
			<div className="id-form">
				<input
					className="id-input"
					placeholder="Add a handle…"
					aria-label="Handle to link"
					value={alias}
					onChange={(event) => setAlias(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") void link();
					}}
				/>
				<select
					className="id-select"
					aria-label="Handle kind"
					value={aliasKind}
					onChange={(event) => setAliasKind(event.target.value)}
				>
					{ALIAS_KINDS.map((kind) => (
						<option key={kind} value={kind}>
							{kind}
						</option>
					))}
				</select>
				<button
					type="button"
					className="oi-btn oi-btn--apply"
					disabled={linking || !alias.trim()}
					onClick={() => void link()}
				>
					Link
				</button>
			</div>
			{linkError && <p className="oi-note oi-note--bad">{linkError}</p>}

			{/* Manual merge — destructive, so it queues rather than applying. */}
			<div className="id-form">
				<input
					className="id-input"
					placeholder="Merge another name into this one…"
					aria-label="Entity to merge in"
					value={mergeSource}
					onChange={(event) => setMergeSource(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") void queueMerge();
					}}
				/>
				<button
					type="button"
					className="oi-btn"
					disabled={merging || !mergeSource.trim()}
					onClick={() => void queueMerge()}
				>
					Queue merge
				</button>
			</div>
			{mergeNote && <p className="oi-note">{mergeNote}</p>}

			{/* Touched, grouped by source: connector rows carry a deep link, the
			    extraction population does not, so one flat list reads inconsistent. */}
			{groups.map((group) => (
				<div key={group.sourceKind || "extracted"} className="id-group">
					<div className="id-group-head">
						{group.label} · {group.items.length}
					</div>
					{group.items.slice(0, 12).map((item) => {
						const title = touchedTitle(item.name);
						return (
							<div key={`${item.entityId}:${item.relation}`} className="id-touched" title={item.name}>
								<span className="id-touched-rel">{item.relation}</span>
								{item.deepLink ? (
									<a className="id-touched-name" href={item.deepLink}>
										{title}
									</a>
								) : (
									<span className="id-touched-name">{title}</span>
								)}
							</div>
						);
					})}
					{group.items.length > 12 && <div className="id-group-more">+{group.items.length - 12} more</div>}
				</div>
			))}
		</section>
	);
}
