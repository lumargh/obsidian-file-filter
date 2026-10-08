import { App, PluginSettingTab, Setting } from 'obsidian';
import type FileFilterPlugin from './main';

export interface FileFilterSettings {
	preserveStructure: boolean;
	showEllipses: boolean;
	folderView: boolean;
}

export const DEFAULT_SETTINGS: FileFilterSettings = {
	preserveStructure: false,
	showEllipses: true,
	folderView: true,
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

		new Setting(containerEl)
			.setName('Show ellipses')
			.setDesc('Show a ··· separator where filtered-out content is hidden.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.showEllipses)
					.onChange(async (value) => {
						this.plugin.settings.showEllipses = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Open folders in folder view')
			.setDesc('Clicking a folder name in the file explorer narrows it to that folder. When off, clicking expands or collapses the folder as usual.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.folderView)
					.onChange(async (value) => {
						this.plugin.settings.folderView = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
