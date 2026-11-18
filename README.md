# SO-101 Web Studio

The browser simulator supports Python routes, a visual route editor, browser-local saves, and downloads. The Python route parser runs locally in the browser using Pyodide. The visual Route Lab works without the Python runtime.

Web Studio uses CodeMirror 5.65.21 for Python syntax highlighting and completion. Use several joint keys in the same `robot.send_action({...})` call to move them together in the simulator or through direct USB. The local bridge supports calibration and single-joint moves. After calibrating, reconnect by USB to deploy grouped moves.

Open **Start here** in Web Studio for the first-run guide. In desktop Chrome or Edge, open **Arm setup**, select **Connect by USB**, and choose the serial port of your calibrated SO-101. Preview the route, review the list in **Prepare deployment**, then select **Confirm and run route** once. **Settings** stores USB profiles and calibration copies in the browser. Direct USB reads the calibration already on the servos.

For a new calibration, calibration restore, or access to your existing local profiles, [download the Studio bridge](SO101-Studio-Bridge.zip). Follow **START HERE.txt**, then pair the bridge in **Arm setup**. The hosted page provides the same profile editing and calibration controls as the local Studio when paired.

The packed geometry and joint frames are adapted from the [SO-101 ROS 2 project](https://github.com/adoodevv/so101_ros2/tree/3fb5182614b8e672ab8784b2a10b50656f976c9c). The browser model quantizes the mesh coordinates and removes degenerate or duplicate triangles. See the [geometry licenses](LICENSE-so101-ros2.txt) and [mesh license](LICENSE-meshes.txt).
