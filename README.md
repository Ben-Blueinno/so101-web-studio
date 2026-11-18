# SO-101 Web Studio

The browser simulator supports Python routes, browser-local saves, and downloads. Use the **Codebook** switch in **Simulation** to open Python examples and motor ranges. The 3D preview moves below the editor. The Python route parser runs locally in the browser using Pyodide.

Web Studio uses CodeMirror 5.65.21 for Python syntax highlighting and completion. Use several joint keys in the same `robot.send_action({...})` call to move them together in the simulator or through direct USB. The local bridge supports calibration and single-joint moves. After calibrating, reconnect by USB to deploy grouped moves.

Open **Start here** for the four steps. Use **Show me how** on each tab for its guide. **Coming soon** lists the stages from tabletop followers to XLeRobot. In desktop Chrome or Edge, open **USB connection**, select **Connect by USB**, and choose the serial port of your calibrated SO-101. **Settings → Scan ports** opens the same browser picker and remembers the port for the next connection. Preview the route in **Simulation**, review the list in **Deployment** via **Prepare deployment**, then select **Confirm and run route** once. Direct USB reads the calibration already on the servos.

In **Calibration**, use **Calibrate new** to capture the midpoint and usable range on an assembled SO-101. To restore a calibration over USB, import and save the same arm’s JSON in **Settings**, assign it to the follower profile, and choose **Restore saved calibration**. For access to old local profiles, the [legacy Studio bridge](SO101-Studio-Bridge.zip) remains available.

The packed geometry and joint frames are adapted from the [SO-101 ROS 2 project](https://github.com/adoodevv/so101_ros2/tree/3fb5182614b8e672ab8784b2a10b50656f976c9c). The browser model quantizes the mesh coordinates and removes degenerate or duplicate triangles. See the [geometry licenses](LICENSE-so101-ros2.txt) and [mesh license](LICENSE-meshes.txt).
