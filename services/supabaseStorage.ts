// Supabase Storage service for uploading video/audio files
// Files get public URLs that Shotstack can use

const BUCKET_NAME = 'syncmaster-media';

export class SupabaseStorageService {
  private supabaseUrl: string = '';
  private supabaseKey: string = '';
  private uploadedFiles: Map<string, string> = new Map(); // fileId -> publicUrl

  configure(url: string, anonKey: string) {
    this.supabaseUrl = url.replace(/\/$/, ''); // Remove trailing slash
    this.supabaseKey = anonKey;
  }

  isConfigured(): boolean {
    return !!(this.supabaseUrl && this.supabaseKey);
  }

  // Generate a unique filename
  private generateFileName(file: File, prefix: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    const ext = file.name.split('.').pop() || 'mp4';
    return `${prefix}_${timestamp}_${random}.${ext}`;
  }

  // Upload a file and return its public URL
  async uploadFile(file: File, prefix: string = 'clip'): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Supabase not configured');
    }

    // Check if we already uploaded this file (by name + size as key)
    const fileKey = `${file.name}_${file.size}`;
    if (this.uploadedFiles.has(fileKey)) {
      console.log(`File already uploaded: ${file.name}`);
      return this.uploadedFiles.get(fileKey)!;
    }

    const fileName = this.generateFileName(file, prefix);
    const filePath = `exports/${fileName}`;

    console.log(`Uploading to Supabase: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    // Upload using Supabase Storage REST API
    const uploadUrl = `${this.supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${filePath}`;

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.supabaseKey}`,
        'Content-Type': file.type || 'video/mp4',
        'x-upsert': 'true' // Overwrite if exists
      },
      body: file
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Supabase upload error:', response.status, errorText);

      // If bucket doesn't exist, give helpful error
      if (response.status === 404 || errorText.includes('not found')) {
        throw new Error(`Bucket "${BUCKET_NAME}" not found. Create it in Supabase Dashboard → Storage`);
      }
      throw new Error(`Upload failed: ${response.status}`);
    }

    // Construct public URL
    const publicUrl = `${this.supabaseUrl}/storage/v1/object/public/${BUCKET_NAME}/${filePath}`;

    console.log(`Uploaded: ${publicUrl}`);

    // Cache for reuse
    this.uploadedFiles.set(fileKey, publicUrl);

    return publicUrl;
  }

  // Upload multiple files with progress callback
  async uploadFiles(
    files: { file: File; prefix: string }[],
    onProgress: (uploaded: number, total: number, currentFile: string) => void
  ): Promise<string[]> {
    const urls: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const { file, prefix } = files[i];
      onProgress(i, files.length, file.name);
      const url = await this.uploadFile(file, prefix);
      urls.push(url);
    }

    onProgress(files.length, files.length, 'Done');
    return urls;
  }

  // Clear cached uploads (call when starting fresh export)
  clearCache() {
    this.uploadedFiles.clear();
  }
}

export const supabaseStorage = new SupabaseStorageService();
