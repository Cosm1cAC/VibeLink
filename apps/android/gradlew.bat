@echo off
setlocal

rem Windows entry point for the project Gradle wrapper.
set "DIR=%~dp0"
set "JAVA_EXE="

if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "JAVA_EXE=%JAVA_HOME%\bin\java.exe"

if not defined JAVA_EXE (
    for /f "delims=" %%J in ('where java 2^>nul') do if not defined JAVA_EXE set "JAVA_EXE=%%J"
)

if not defined JAVA_EXE (
    echo ERROR: Java 17 is required to run the Android Gradle build.
    echo Install a JDK 17 and set JAVA_HOME, then run this command again.
    exit /b 1
)

if not defined ANDROID_HOME set "ANDROID_HOME=%DIR%..\..\.agent-mobile-terminal\android-sdk"
if not defined ANDROID_SDK_ROOT set "ANDROID_SDK_ROOT=%ANDROID_HOME%"

"%JAVA_EXE%" -Dorg.gradle.appname=gradlew -classpath "%DIR%gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
exit /b %ERRORLEVEL%
