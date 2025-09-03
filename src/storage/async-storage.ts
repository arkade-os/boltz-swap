import { Storage } from './interface';

/**
 * React Native / Expo AsyncStorage implementation
 * Note: This requires @react-native-async-storage/async-storage to be installed
 */
export class AsyncStorage implements Storage {
  private asyncStorage: any;

  constructor(asyncStorage: any) {
    if (!asyncStorage) {
      throw new Error('AsyncStorage instance is required. Import it from @react-native-async-storage/async-storage');
    }
    this.asyncStorage = asyncStorage;
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return await this.asyncStorage.getItem(key);
    } catch (error) {
      console.error('Error getting item from AsyncStorage:', error);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      await this.asyncStorage.setItem(key, value);
    } catch (error) {
      throw new Error(`Failed to set item in AsyncStorage: ${error}`);
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await this.asyncStorage.removeItem(key);
    } catch (error) {
      console.error('Error removing item from AsyncStorage:', error);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.asyncStorage.clear();
    } catch (error) {
      console.error('Error clearing AsyncStorage:', error);
    }
  }
}
