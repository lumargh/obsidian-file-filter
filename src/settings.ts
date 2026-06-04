import { App, PluginSettingTab, Setting } from 'obsidian';
import FileFilterPlugin from './main';

export interface FileFilterSettings {
	// settings will be defined once we know what the plugin does
}

export const DEFAULT_SETTINGS: FileFilterSettings = {
	// defaults will be defined once we know what the plugin does
};

export class FileFilterSettingTab extends PluginSettingTab {
	plugin: FileFilterPlugin;

	constructor(app: App, plugin: FileFilterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('File Filter').setHeading();
	}
}
