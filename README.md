# SO-101 Web Studio

The browser simulator supports Python routes, a visual route editor, browser-local saves, and downloads. The Python route parser runs locally in the browser using Pyodide. The visual Route Lab works without the Python runtime.

To use a physical arm, [download the Studio bridge](SO101-Studio-Bridge.zip) on the Mac or Windows computer connected to the SO-101 over USB. Follow **START HERE.txt** in the archive, then open the hosted page in Chrome or Edge. Each computer gets its own pairing code. Use the local Studio to set up the follower and its calibration, and the hosted page to preview and confirm one move at a time.

The packed geometry and joint frames are adapted from the [SO-101 ROS 2 project](https://github.com/adoodevv/so101_ros2/tree/3fb5182614b8e672ab8784b2a10b50656f976c9c). The browser model quantizes the mesh coordinates and removes degenerate or duplicate triangles. See the [geometry licenses](LICENSE-so101-ros2.txt) and [mesh license](LICENSE-meshes.txt).
