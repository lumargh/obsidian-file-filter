import { App, PluginSettingTab, Setting } from 'obsidian';
import type FileFilterPlugin from './main';

export interface FileFilterSettings {
	preserveStructure: boolean;
}

export const DEFAULT_SETTINGS: FileFilterSettings = {
	preserveStructure: false,
};

export class FileFilterSettingTab extends PluginSettingTab {
	private plugin: FileFilterPlugin;

	constructor(app: App, plugin: FileFilterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Preserve structure')
			.setDesc(
				'When filtering a page, keep ancestor headers of matching blocks visible ' +
				'even if they don\'t contain the search term.',
			)
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.preserveStructure)
					.onChange(async (value) => {
						this.plugin.settings.preserveStructure = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
