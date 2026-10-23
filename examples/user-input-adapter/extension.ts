/**
 * External user-input adapter example.
 *
 * This module holds the adapter; it is not itself an extension entry. Add an entry file beside it
 * that supplies your authenticated client bridge:
 *
 *   import { createUserInputAdapterExtension } from "./extension.ts";
 *   export default createUserInputAdapterExtension(myAuthenticatedTransport);
 *
 * The bridge owns authentication. It accepts text only from a sender it has authenticated and
 * returns the binding the person saw when they composed the message. This module never sends
 * automated input and never falls back to pi.sendUserMessage().
 *
 * The adapter ID must be authorized in Jouzu's user-input-adapters.json. See
 * docs/user-input-adapters.md.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const ADAPTER = { id: "external-input", label: "Authenticated external input" } as const;

type Adapter = Awaited<ReturnType<ExtensionAPI["registerUserInputAdapter"]>>;

/** Opaque target and generation to publish to the authenticated client. */
export type UserInputBinding = Awaited<ReturnType<Adapter["bind"]>>;

/** Delivery receipt for one message ID. */
export type UserInputReceipt = Awaited<ReturnType<Adapter["submit"]>>;

/** One message composed by an authenticated person. */
export interface ClientMessage {
	/** Binding the client received when this message was composed. */
	binding: UserInputBinding;
	/** Stable client message ID. Reuse it for retries and receipt recovery. */
	messageId: string;
	text: string;
	deliverAs: "steer" | "followUp";
}

/** A structured failure the client can show or retry against. */
export interface AdapterFailure {
	code: string;
	text: string;
	messageId?: string;
}

/** The authenticated client bridge. Replace this seam with your own transport. */
export interface AuthenticatedClientTransport {
	/** Publish the current target, or undefined once the session releases it. */
	setBinding(binding: UserInputBinding | undefined): void;
	/** Publish a receipt snapshot or update. */
	setReceipt(receipt: UserInputReceipt): void;
	/** Report a structured failure for the client to show. */
	reportFailure(failure: AdapterFailure): void;
	/** Deliver authenticated messages. Returns an unsubscribe function. */
	onMessage(listener: (message: ClientMessage) => void): () => void;
	/** Deliver reconnects with unresolved message IDs. Returns an unsubscribe function. */
	onReconnect(listener: (messages: readonly { target: string; messageId: string }[]) => void): () => void;
}

const errorCode = (error: unknown): string =>
	typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: "adapter-failed";

function toFailure(error: unknown, messageId?: string): AdapterFailure {
	const code = errorCode(error);
	const text = error instanceof Error ? error.message : "External user input failed.";
	return messageId === undefined ? { code, text } : { code, text, messageId };
}

export function createUserInputAdapterExtension(transport: AuthenticatedClientTransport): ExtensionFactory {
	return (pi) => {
		let lifecycle = 0;
		let bindingOperation = 0;
		let adapter: Adapter | undefined;
		let binding: UserInputBinding | undefined;
		let stopReceipts: (() => void) | undefined;
		let stopMessages: (() => void) | undefined;
		let stopReconnects: (() => void) | undefined;
		let stopTarget: (() => void) | undefined;

		const release = () => {
			lifecycle++;
			bindingOperation++;
			stopReceipts?.();
			stopMessages?.();
			stopReconnects?.();
			stopTarget?.();
			stopReceipts = stopMessages = stopReconnects = stopTarget = undefined;
			const published = binding !== undefined;
			adapter = undefined;
			binding = undefined;
			if (published) transport.setBinding(undefined);
		};

		/** Withdraw the published target. The registration stays live for the next binding. */
		const withdraw = () => {
			bindingOperation++;
			stopReceipts?.();
			stopReceipts = undefined;
			const published = binding !== undefined;
			binding = undefined;
			if (published) transport.setBinding(undefined);
		};

		/** Bind the current target and publish it with a receipt subscription for this attachment. */
		const bindCurrent = async (operation = ++bindingOperation) => {
			const current = adapter;
			if (!current) return;
			const generation = lifecycle;
			const active = () => lifecycle === generation && bindingOperation === operation && adapter === current;
			let next: UserInputBinding;
			try {
				next = await current.bind();
			} catch (error) {
				if (!active()) return;
				throw error;
			}
			if (!active()) return;
			stopReceipts?.();
			stopReceipts = undefined;
			binding = next;
			// A subscription publishes a current snapshot first, then journal-triggered updates.
			const stop = current.subscribe((receipt) => {
				if (active()) transport.setReceipt(receipt);
			});
			// The snapshot listener may synchronously withdraw this target or end the session.
			if (!active()) {
				stop();
				return;
			}
			stopReceipts = stop;
			transport.setBinding(next);
		};

		/**
		 * A branch change and a target reset both need a fresh binding, not a new registration: the
		 * registration survives, and messages composed against the withdrawn target are never retargeted.
		 */
		const rebind = async (ctx: ExtensionContext) => {
			const current = adapter;
			if (!current) return;
			const generation = lifecycle;
			withdraw();
			const operation = bindingOperation;
			try {
				await bindCurrent(operation);
			} catch (error) {
				if (lifecycle !== generation || bindingOperation !== operation || adapter !== current) return;
				const failure = toFailure(error);
				transport.reportFailure(failure);
				if (ctx.hasUI) ctx.ui.notify(`External user input: ${failure.text}`, "error");
			}
		};

		const submit = async (message: ClientMessage) => {
			const current = adapter;
			if (!current) {
				transport.reportFailure({
					code: "target-unavailable",
					text: "No external user-input adapter is bound.",
					messageId: message.messageId,
				});
				return;
			}
			try {
				// Forward only the documented fields, and keep the binding the person saw.
				const receipt = await current.submit({
					binding: message.binding,
					messageId: message.messageId,
					text: message.text,
					deliverAs: message.deliverAs,
				});
				if (adapter === current) transport.setReceipt(receipt);
			} catch (error) {
				if (adapter === current) transport.reportFailure(toFailure(error, message.messageId));
			}
		};

		const recover = async (messages: readonly { target: string; messageId: string }[]) => {
			const current = adapter;
			if (!current) {
				for (const { messageId } of messages)
					transport.reportFailure({
						code: "target-unavailable",
						text: "No external user-input adapter is bound.",
						messageId,
					});
				return;
			}
			for (const { target, messageId } of messages) {
				try {
					const receipt = await current.lookup({ target, messageId });
					if (adapter !== current) return;
					// Undefined means no retained record; the client keeps the message pending.
					if (receipt) transport.setReceipt(receipt);
				} catch (error) {
					if (adapter !== current) return;
					transport.reportFailure(toFailure(error, messageId));
				}
			}
		};

		const start = async (ctx: ExtensionContext) => {
			release();
			const generation = lifecycle;
			// Feature detection is explicit. An older or non-Jouzu host must not fall back to
			// sending the text as an automated message.
			if (typeof pi.registerUserInputAdapter !== "function") {
				const failure = {
					code: "unsupported-protocol",
					text: "This host does not support external user-input adapters.",
				};
				transport.reportFailure(failure);
				if (ctx.hasUI) ctx.ui.notify(`External user input: ${failure.text}`, "error");
				return;
			}
			try {
				const registered = await pi.registerUserInputAdapter(ADAPTER);
				if (lifecycle !== generation) return;
				adapter = registered;
				// A reset that starts a new target epoch withdraws the published target here. Older
				// hosts do not report it, so the refresh below still runs at every branch change.
				const watch = registered.onTargetInvalidated;
				stopTarget = typeof watch === "function" ? watch(() => void rebind(ctx)) : undefined;
				await bindCurrent();
				if (lifecycle !== generation) return;
				stopMessages = transport.onMessage((message) => void submit(message));
				stopReconnects = transport.onReconnect((messageIds) => void recover(messageIds));
			} catch (error) {
				if (lifecycle !== generation) return;
				release();
				const failure = toFailure(error);
				transport.reportFailure(failure);
				if (ctx.hasUI) ctx.ui.notify(`External user input: ${failure.text}`, "error");
			}
		};

		// No work at factory load: registration starts with the session.
		pi.on("session_start", async (_event, ctx) => {
			await start(ctx);
		});
		// A branch change needs a fresh target and a receipt subscription for the new branch. The
		// registration survives branch navigation, so only the binding and subscription are replaced.
		pi.on("session_tree", async (_event, ctx) => {
			await rebind(ctx);
		});
		// Release listeners and the published target. Safe to call more than once.
		pi.on("session_shutdown", () => {
			release();
		});
	};
}
