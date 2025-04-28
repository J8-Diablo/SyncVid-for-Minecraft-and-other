# SyncVid-for-Minecraft-and-Other

## Overview
SyncVid is a lightweight Node.js application designed to synchronize and display videos for Minecraft sessions or other creative setups. It provides a simple web-based control panel to upload, manage, and play videos in sync across multiple clients.


## Minecraft Prewiew
<p align="center">
  <video src="https://github.com/J8-Diablo/SyncVid-for-Minecraft-and-other/blob/main/demo/Demo.mp4" width="450" controls></video>
</p>

## Features
- **Easy Setup**: Clone the repository and install dependencies with a single command.
- **Web-based Control**: Access a control panel to manage video playback.
- **Customizable**: Change server settings and port as needed.
- **Open Source**: Licensed under CC BY-NC 4.0.

## Requirements
- Node.js (v14 or higher)
- npm (v6 or higher)

## Installation

1. **Clone the repository**  
   ```bash
   git clone git@github.com:J8-Diablo/SyncVid-for-Minecraft-and-other.git
   cd SyncVid-for-Minecraft-and-other
   ```

2. **Install dependencies**  
   ```bash
   npm install
   ```

## Usage

1. **Start the server**  
   ```bash
   npm start
   ```
2. **Open the control panel**  
   Navigate to: [http://127.0.0.1:3000/control](http://127.0.0.1:3000/control)

3. **Change default port (optional)**  
   Edit the port value at the bottom of `server.js` (default is `3000`).

## Known Issues

- **Security**: No authentication—exposing the app publicly allows anyone to control your instance.
- **Vulnerabilities**: `npm install` may report high-severity vulnerabilities. You can try to fix them—you might know how to secure the project better than I can 😅​.
- **Video Uploads**: Some videos may fail to upload; as a workaround, add them manually to the `public/video` directory.

## Roadmap

- **Authentication**: Add login for the control panel.
- **Unauthenticated** Display Access: Provide a configuration option to enable or disable public (read-only) access to the display page without requiring authentication.


## License

This project is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/).

You are free to:
- **Share** — copy and redistribute the material in any medium or format.
- **Adapt** — remix, transform, and build upon the material.

Under the following terms:
- **Attribution** — You must give appropriate credit.  
- **NonCommercial** — You may not use the material for commercial purposes.

## Credits

- **JDiablo** (GitHub: [J8-Diablo](https://github.com/J8-Diablo) Original author)  
- **Hugo Dupont** (Original author Name)
