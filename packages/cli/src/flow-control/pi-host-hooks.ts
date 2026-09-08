/** Restore owned host hooks in reverse installation order, preserving later replacements. */
export class PiHostHooks {
	private readonly releases: (() => void)[] = [];
	set<T extends object, K extends keyof T>(target: T, key: K, installed: T[K]): void {
		const previous = target[key];
		target[key] = installed;
		this.releases.push(() => {
			if (target[key] === installed) target[key] = previous;
		});
	}
	close(): void {
		for (const release of this.releases.splice(0).reverse()) release();
	}
}
